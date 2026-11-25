/** Runs this store's SQL through another connection (the server's own
 *  database session) instead of a sqlite3 process per statement. */
export interface ArtifactSqlExecutor {
  queryJson<T>(sql: string): Promise<T[]>;
  queryText(sql: string): Promise<string>;
  runSql(sql: string): Promise<void>;
}

export interface ArtifactRecord {
  id: string;
  conversationId: string;
  name: string;
  owner: string;
  contributors: string[];
  requiredSigners: string[];
  labels: string[];
  lifecycle: "collecting_drafts" | "published";
  allowedDraftAuthors: string[];
  requiredDraftAuthors: string[];
  audiencePolicyByAuthor: Record<string, { allowedReaders: string[]; requiredReaders: string[] }>;
  draftRosterRevision: number;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** The chat message this collection was started for (see types.ts). */
  originMessageId?: string;
}

export interface ArtifactDraftRecord {
  id: string;
  artifactId: string;
  author: string;
  state: "editing" | "submitted" | "superseded" | "withdrawn";
  content: string;
  readers: string[];
  editRevision: number;
  supersedesDraftId?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
}

export interface ArtifactVersionSourceRecord {
  artifactId: string;
  version: number;
  draftId: string;
  author: string;
  submittedAt: string;
  contentHash: string;
  disposition: "considered" | "excluded";
  exclusionRationale?: string;
}

export interface ArtifactOperationRecord {
  conversationId: string;
  artifactId?: string;
  actor: string;
  operationKind: string;
  operationId: string;
  requestHash: string;
  resultJson: string;
  createdAt: string;
}

export interface ArtifactEventRecord {
  id: string;
  conversationId: string;
  artifactId: string;
  kind: string;
  actor: string;
  content: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface ArtifactVersionRecord {
  artifactId: string;
  version: number;
  versionEventId?: string;
  contentHash?: string;
  baseVersionEventId?: string;
  content: string;
  author: string;
  note?: string;
  createdAt: string;
}

export interface ArtifactVersionMetaRecord {
  artifactId: string;
  version: number;
  versionEventId: string;
  contentHash: string;
  author: string;
  note?: string;
  createdAt: string;
}

export interface ArtifactSignatureRecord {
  artifactId: string;
  version?: number;
  versionEventId: string;
  contentHash: string;
  signer: string;
  signedAt: string;
}
