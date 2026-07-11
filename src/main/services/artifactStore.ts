import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command";

// SQLite persistence for artifacts. Deliberately independent from conversation
// payload storage: artifacts must survive chat compaction, agent session loss,
// and app restarts, and are append-only at the version level. Uses the same
// sqlite3-CLI approach as StorageService (no native binding), but takes an
// explicit dbPath so it can run under plain `node --test` without Electron.

const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const SQLITE_COMMAND_TIMEOUT_MS = 45_000;

export interface ArtifactRecord {
  id: string;
  conversationId: string;
  name: string;
  owner: string;
  contributors: string[];
  requiredSigners: string[];
  labels: string[];
  headVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersionRecord {
  artifactId: string;
  version: number;
  content: string;
  author: string;
  note?: string;
  createdAt: string;
}

export interface ArtifactVersionMetaRecord {
  artifactId: string;
  version: number;
  author: string;
  note?: string;
  createdAt: string;
}

export interface ArtifactSignatureRecord {
  artifactId: string;
  version: number;
  signer: string;
  signedAt: string;
}

interface ArtifactRow {
  id: string;
  conversationId: string;
  name: string;
  owner: string;
  contributorsJson: string;
  requiredSignersJson: string;
  labelsJson: string;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
}

function sqlString(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return "NULL";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

const ARTIFACT_SELECT = `
  select
    id,
    conversation_id as conversationId,
    name,
    owner,
    contributors_json as contributorsJson,
    required_signers_json as requiredSignersJson,
    labels_json as labelsJson,
    head_version as headVersion,
    created_at as createdAt,
    updated_at as updatedAt
  from artifacts
`;

export class ArtifactStore {
  private initialized = false;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    await this.runSql(`
      create table if not exists artifacts (
        id text primary key,
        conversation_id text not null,
        name text not null,
        name_key text not null,
        owner text not null,
        contributors_json text not null,
        required_signers_json text not null,
        labels_json text not null,
        head_version integer not null,
        created_at text not null,
        updated_at text not null
      );
      create unique index if not exists idx_artifacts_conversation_name_key on artifacts(conversation_id, name_key);
      create index if not exists idx_artifacts_conversation_updated on artifacts(conversation_id, updated_at);
      create table if not exists artifact_versions (
        artifact_id text not null,
        version integer not null,
        content text not null,
        author text not null,
        note text,
        created_at text not null,
        primary key (artifact_id, version)
      );
      create table if not exists artifact_signatures (
        artifact_id text not null,
        version integer not null,
        signer text not null,
        signed_at text not null,
        primary key (artifact_id, version, signer)
      );
    `);
    this.initialized = true;
  }

  async insertArtifact(record: ArtifactRecord, nameKey: string, firstVersion: ArtifactVersionRecord): Promise<void> {
    await this.init();
    await this.runSql(`
      begin immediate;
      insert into artifacts (
        id, conversation_id, name, name_key, owner,
        contributors_json, required_signers_json, labels_json,
        head_version, created_at, updated_at
      ) values (
        ${sqlString(record.id)},
        ${sqlString(record.conversationId)},
        ${sqlString(record.name)},
        ${sqlString(nameKey)},
        ${sqlString(record.owner)},
        ${sqlString(JSON.stringify(record.contributors))},
        ${sqlString(JSON.stringify(record.requiredSigners))},
        ${sqlString(JSON.stringify(record.labels))},
        ${Math.floor(record.headVersion)},
        ${sqlString(record.createdAt)},
        ${sqlString(record.updatedAt)}
      );
      insert into artifact_versions (artifact_id, version, content, author, note, created_at)
      values (
        ${sqlString(firstVersion.artifactId)},
        ${Math.floor(firstVersion.version)},
        ${sqlString(firstVersion.content)},
        ${sqlString(firstVersion.author)},
        ${sqlString(firstVersion.note)},
        ${sqlString(firstVersion.createdAt)}
      );
      commit;
    `);
  }

  async getById(id: string): Promise<ArtifactRecord | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactRow>(`${ARTIFACT_SELECT} where id = ${sqlString(id)} limit 1;`);
    return rows[0] ? this.recordFromRow(rows[0]) : undefined;
  }

  async getByName(conversationId: string, nameKey: string): Promise<ArtifactRecord | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactRow>(
      `${ARTIFACT_SELECT} where conversation_id = ${sqlString(conversationId)} and name_key = ${sqlString(nameKey)} limit 1;`
    );
    return rows[0] ? this.recordFromRow(rows[0]) : undefined;
  }

  async listByConversation(conversationId: string): Promise<ArtifactRecord[]> {
    await this.init();
    const rows = await this.queryJson<ArtifactRow>(
      `${ARTIFACT_SELECT} where conversation_id = ${sqlString(conversationId)} order by updated_at desc, name asc;`
    );
    return rows.map((row) => this.recordFromRow(row));
  }

  async getVersion(artifactId: string, version: number): Promise<ArtifactVersionRecord | undefined> {
    await this.init();
    const rows = await this.queryJson<ArtifactVersionRecord & { note: string | null }>(
      `
        select artifact_id as artifactId, version, content, author, note, created_at as createdAt
        from artifact_versions
        where artifact_id = ${sqlString(artifactId)} and version = ${Math.floor(version)}
        limit 1;
      `
    );
    const row = rows[0];
    return row ? { ...row, note: row.note ?? undefined } : undefined;
  }

  async listVersionMetas(artifactId: string): Promise<ArtifactVersionMetaRecord[]> {
    await this.init();
    const rows = await this.queryJson<ArtifactVersionMetaRecord & { note: string | null }>(
      `
        select artifact_id as artifactId, version, author, note, created_at as createdAt
        from artifact_versions
        where artifact_id = ${sqlString(artifactId)}
        order by version asc;
      `
    );
    return rows.map((row) => ({ ...row, note: row.note ?? undefined }));
  }

  async listSignatures(artifactId: string): Promise<ArtifactSignatureRecord[]> {
    await this.init();
    return this.queryJson<ArtifactSignatureRecord>(
      `
        select artifact_id as artifactId, version, signer, signed_at as signedAt
        from artifact_signatures
        where artifact_id = ${sqlString(artifactId)}
        order by version asc, signed_at asc;
      `
    );
  }

  async listHeadSignaturesByArtifact(conversationId: string): Promise<Map<string, ArtifactSignatureRecord[]>> {
    await this.init();
    const rows = await this.queryJson<ArtifactSignatureRecord>(
      `
        select s.artifact_id as artifactId, s.version, s.signer, s.signed_at as signedAt
        from artifact_signatures s
        join artifacts a on a.id = s.artifact_id and a.head_version = s.version
        where a.conversation_id = ${sqlString(conversationId)}
        order by s.signed_at asc;
      `
    );
    const byArtifact = new Map<string, ArtifactSignatureRecord[]>();
    for (const row of rows) {
      const list = byArtifact.get(row.artifactId) ?? [];
      list.push(row);
      byArtifact.set(row.artifactId, list);
    }
    return byArtifact;
  }

  // Append a new head version guarded by the expected current head. Returns
  // true only when THIS call performed the write. Comparing the resulting head
  // to the target version is not enough: a competing writer racing to the same
  // target would make the loser look successful and silently drop its content.
  // Instead the guarded update runs inside one immediate transaction and
  // `changes()` reports whether this writer's update took effect.
  async appendVersion(record: ArtifactVersionRecord, expectedHeadVersion: number): Promise<boolean> {
    await this.init();
    const id = sqlString(record.artifactId);
    const expected = Math.floor(expectedHeadVersion);
    const version = Math.floor(record.version);
    const output = await this.queryText(`
      begin immediate;
      insert into artifact_versions (artifact_id, version, content, author, note, created_at)
      select ${id}, ${version}, ${sqlString(record.content)}, ${sqlString(record.author)}, ${sqlString(record.note)}, ${sqlString(record.createdAt)}
      where (select head_version from artifacts where id = ${id}) = ${expected};
      update artifacts
      set head_version = ${version}, updated_at = ${sqlString(record.createdAt)}
      where id = ${id} and head_version = ${expected};
      select changes();
      commit;
    `);
    return Number.parseInt(output.trim(), 10) === 1;
  }

  async updateName(id: string, name: string, nameKey: string, updatedAt: string): Promise<void> {
    await this.init();
    await this.runSql(`
      update artifacts
      set name = ${sqlString(name)}, name_key = ${sqlString(nameKey)}, updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
    `);
  }

  async updateAccess(
    id: string,
    access: { owner: string; contributors: string[]; requiredSigners: string[]; labels: string[] },
    updatedAt: string
  ): Promise<void> {
    await this.init();
    await this.runSql(`
      update artifacts
      set
        owner = ${sqlString(access.owner)},
        contributors_json = ${sqlString(JSON.stringify(access.contributors))},
        required_signers_json = ${sqlString(JSON.stringify(access.requiredSigners))},
        labels_json = ${sqlString(JSON.stringify(access.labels))},
        updated_at = ${sqlString(updatedAt)}
      where id = ${sqlString(id)};
    `);
  }

  // Idempotent: returns true when the signature was newly recorded, false when
  // this signer had already signed this version.
  async insertSignature(record: ArtifactSignatureRecord): Promise<boolean> {
    await this.init();
    const existing = await this.queryText(
      `
        select signer from artifact_signatures
        where artifact_id = ${sqlString(record.artifactId)}
          and version = ${Math.floor(record.version)}
          and signer = ${sqlString(record.signer)}
        limit 1;
      `
    );
    if (existing) {
      return false;
    }
    await this.runSql(`
      insert or ignore into artifact_signatures (artifact_id, version, signer, signed_at)
      values (
        ${sqlString(record.artifactId)},
        ${Math.floor(record.version)},
        ${sqlString(record.signer)},
        ${sqlString(record.signedAt)}
      );
    `);
    return true;
  }

  async touch(id: string, updatedAt: string): Promise<void> {
    await this.init();
    await this.runSql(`update artifacts set updated_at = ${sqlString(updatedAt)} where id = ${sqlString(id)};`);
  }

  private recordFromRow(row: ArtifactRow): ArtifactRecord {
    return {
      id: row.id,
      conversationId: row.conversationId,
      name: row.name,
      owner: row.owner,
      contributors: parseStringArray(row.contributorsJson),
      requiredSigners: parseStringArray(row.requiredSignersJson),
      labels: parseStringArray(row.labelsJson),
      headVersion: typeof row.headVersion === "number" ? row.headVersion : Number.parseInt(String(row.headVersion), 10) || 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  private async queryJson<T>(sql: string): Promise<T[]> {
    const result = await runCommand("sqlite3", this.sqliteArgs(["-json", this.dbPath, sql]), {
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    const text = result.stdout.trim();
    return text ? (JSON.parse(text) as T[]) : [];
  }

  private async queryText(sql: string): Promise<string> {
    const result = await runCommand("sqlite3", this.sqliteArgs(["-batch", "-noheader", this.dbPath, sql]), {
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
    return result.stdout.trim();
  }

  private async runSql(sql: string): Promise<void> {
    await runCommand("sqlite3", this.sqliteArgs([this.dbPath]), {
      input: sql,
      timeoutMs: SQLITE_COMMAND_TIMEOUT_MS,
      primeLoginShellEnv: false
    });
  }

  private sqliteArgs(args: string[]): string[] {
    return ["-cmd", `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, ...args];
  }
}
