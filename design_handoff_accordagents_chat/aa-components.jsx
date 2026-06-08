// aa-components.jsx — AccordAgents chat workspace UI components.
const { useState, useRef, useEffect, useLayoutEffect } = React;

/* ============================ Icons (inline lucide-style, 1.75px) ============ */
const I = (p) => {
  const { size = 18, children, sw = 1.75, fill = "none", ...rest } = p;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
    strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>);

};
const Ic = {
  plus: (p) => <I {...p}><path d="M12 5v14M5 12h14" /></I>,
  search: (p) => <I {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></I>,
  settings: (p) => <I {...p}><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></I>,
  panelLeft: (p) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M9 3.5v17" /></I>,
  chevDown: (p) => <I {...p}><path d="m6 9 6 6 6-6" /></I>,
  chevRight: (p) => <I {...p}><path d="m9 6 6 6-6 6" /></I>,
  pencil: (p) => <I {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></I>,
  users: (p) => <I {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></I>,
  refresh: (p) => <I {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></I>,
  moon: (p) => <I {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" /></I>,
  sun: (p) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>,
  copy: (p) => <I {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></I>,
  check: (p) => <I {...p}><path d="M20 6 9 17l-5-5" /></I>,
  msg: (p) => <I {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" /></I>,
  arrowUp: (p) => <I {...p}><path d="M12 19V5M5 12l7-7 7 7" /></I>,
  arrowDown: (p) => <I {...p}><path d="M12 5v14M19 12l-7 7-7-7" /></I>,
  cornerReturn: (p) => <I {...p}><path d="M9 10 4 15l5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></I>,
  mic: (p) => <I {...p}><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 19v3" /></I>,
  paperclip: (p) => <I {...p}><path d="M21.4 11.05 12.25 20.2a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.48-8.49" /></I>,
  image: (p) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 20" /></I>,
  file: (p) => <I {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></I>,
  shield: (p) => <I {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></I>,
  x: (p) => <I {...p}><path d="M18 6 6 18M6 6l12 12" /></I>,
  reply: (p) => <I {...p}><path d="M9 17l-5-5 5-5" /><path d="M4 12h11a5 5 0 0 1 5 5v1" /></I>,
  square: (p) => <I {...p}><rect x="5" y="5" width="14" height="14" rx="2" /></I>,
  spark: (p) => <I {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></I>,
  zap: (p) => <I {...p}><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" /></I>,
  history: (p) => <I {...p}><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></I>,
  hash: (p) => <I {...p}><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></I>,
  thumb: (p) => <I {...p}><path d="M7 10v12" /><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" /></I>,
  smile: (p) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M8 14s1.4 2 4 2 4-2 4-2" /><path d="M9 9h.01M15 9h.01" /></I>,
  stop: (p) => <I {...p}><circle cx="12" cy="12" r="9" /><rect x="9" y="9" width="6" height="6" rx="1" /></I>,
  branch: (p) => <I {...p}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" /><circle cx="18" cy="8" r="3" /><path d="M18 11a6 6 0 0 1-6 6H9" /></I>
};

/* ============================ Provider helpers ============================== */
const provVar = (prov) => prov ? `var(--provider-${prov})` : "var(--app-accent)";
const provSoft = (prov) => prov ? `var(--provider-${prov}-soft)` : "var(--app-accent-soft)";

/* ============================ Avatar ======================================== */
function Avatar({ p, size = 38, mode = "animal", radius = 10 }) {
  const style = { width: size, height: size, borderRadius: radius };
  if (p.kind === "user") {
    return (
      <div className="aa-av aa-av-user" style={style} title="You">
        <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} aria-hidden="true" fill="currentColor">
          <circle cx="12" cy="8.2" r="4.6" /><path d="M3.9 21.4c1.2-4.7 4-7 8.1-7s6.9 2.3 8.1 7z" />
        </svg>
      </div>);

  }
  if (mode === "animal" && p.avatar) {
    return <img className="aa-av" style={style} src={p.avatar} alt={p.name} />;
  }
  return (
    <div className="aa-av aa-av-mono" style={{ ...style, background: provSoft(p.provider), color: provVar(p.provider), boxShadow: `inset 0 0 0 1px ${provVar(p.provider)}33` }}>
      {p.mono}
    </div>);

}

/* ============================ Inline token rendering ======================== */
const INLINE_RE = /(`[^`]+`)|(@[a-z0-9_-]+)|(#[^\s]+)|((?<![\w/])\/[a-z][a-z0-9-]*)/gi;
function renderInline(text) {
  const out = [];
  let last = 0,m,k = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code key={k++} className="aa-inline-code">{m[1].slice(1, -1)}</code>);else
    if (m[2]) out.push(<span key={k++} className="aa-tok aa-tok-handle">{m[2]}</span>);else
    if (m[3]) {
      let raw = m[3],trail = "";
      while (/[.,;:)]$/.test(raw)) {trail = raw.slice(-1) + trail;raw = raw.slice(0, -1);}
      out.push(<span key={k++} className="aa-tok aa-tok-path">{raw}</span>);
      if (trail) out.push(trail);
    } else if (m[4]) out.push(<span key={k++} className="aa-tok aa-tok-skill">{m[4]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ============================ Rich blocks =================================== */
function TextBlock({ b }) {return <p className="aa-text">{renderInline(b.text)}</p>;}

function CodeBlock({ b }) {
  return (
    <div className="aa-code">
      {b.file && <div className="aa-code-head"><Ic.file size={13} /><span>{b.file}</span></div>}
      <pre><code>{b.body}</code></pre>
    </div>);

}

function RunBlock({ b }) {
  return (
    <div className="aa-run">
      {b.label && <div className="aa-run-label">{b.label}</div>}
      {b.lines.map((row, i) =>
      <div className="aa-run-row" key={i}>
          <span className="aa-run-k">{row[0]}</span>
          <span className="aa-run-v">{renderInline(row[1])}</span>
        </div>
      )}
    </div>);

}

function Blocks({ blocks }) {
  return blocks.map((b, i) => {
    if (b.type === "text") return <TextBlock b={b} key={i} />;
    if (b.type === "code") return <CodeBlock b={b} key={i} />;
    if (b.type === "run") return <RunBlock b={b} key={i} />;
    return null;
  });
}

/* ============================ Approval card (minimal) ====================== */
function grantNodes(grants) {
  return grants.map((g, i) =>
  g.kind === "shell" ?
  <span key={i}>shell rule <code className="aa-inline-code">{g.label}</code></span> :
  <span key={i}>{g.label}</span>
  );
}
function joinAnd(nodes) {
  if (nodes.length <= 1) return nodes;
  const out = [];
  nodes.forEach((n, i) => {
    if (i > 0) out.push(<span key={`s${i}`}>{i === nodes.length - 1 ? " and " : ", "}</span>);
    out.push(n);
  });
  return out;
}

function ApprovalResolvedLine({ a, outcome, at, onUndo }) {
  const verb = outcome === "deny" ? "Denied" : "Granted";
  const prep = outcome === "deny" ? "for" : "to";
  const scope = outcome === "chat" ? " for this chat" : "";
  return (
    <div className="aa-system">
      <span className="aa-system-dot" />
      <span className="aa-system-text">
        {verb} {joinAnd(grantNodes(a.grants))} {prep} <span className="aa-tok aa-tok-handle">@{a.who}</span>{scope}.
      </span>
      <span className="aa-system-time">{at}</span>
      <button className="aa-system-undo" onClick={onUndo}>Undo</button>
    </div>);

}

function ApprovalCard({ a, onResolve }) {
  const options = a.options || [
  { label: "Yes, allow once", outcome: "once" },
  { label: "Yes, allow for this chat", outcome: "chat" },
  { label: `No, and tell @${a.who} what to do differently`, outcome: "deny" }];

  const [sel, setSel] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const ref = useRef(null);

  const onKey = (e) => {
    if (e.key === "ArrowDown") {e.preventDefault();setSel((s) => (s + 1) % options.length);} else
    if (e.key === "ArrowUp") {e.preventDefault();setSel((s) => (s - 1 + options.length) % options.length);} else
    if (e.key === "Enter") {e.preventDefault();onResolve(options[sel].outcome);} else
    if (/^[1-9]$/.test(e.key)) {const i = +e.key - 1;if (i < options.length) setSel(i);}
  };

  return (
    <div className="aa-perm" tabIndex={0} ref={ref} onKeyDown={onKey}>
      <div className="aa-perm-q">
        Do you want to allow <span className="aa-tok aa-tok-handle">@{a.who}</span> to {a.question}
      </div>
      {a.command &&
      <div className="aa-perm-cmd-wrap">
        <pre className={`aa-perm-cmd ${expanded ? "is-expanded" : ""}`}>{a.command}</pre>
        <button className="aa-perm-expand" onClick={() => setExpanded((v) => !v)}>{expanded ? "Collapse" : "Expand"}</button>
      </div>}
      <div className="aa-perm-opts" role="listbox">
        {options.map((o, i) =>
        <button
          key={i}
          role="option"
          aria-selected={sel === i}
          className={`aa-perm-opt ${sel === i ? "is-sel" : ""}`}
          onMouseEnter={() => setSel(i)}
          onClick={() => setSel(i)}>
          <span className="aa-perm-num">{i + 1}.</span>
          <span className="aa-perm-label">{renderHandles(o.label)}</span>
          {sel === i &&
          <span className="aa-perm-keys"><Ic.arrowUp size={13} /><Ic.arrowDown size={13} /></span>}
        </button>
        )}
      </div>
      <div className="aa-perm-foot">
        <button className="aa-perm-skip" onClick={() => onResolve("deny")}>Skip</button>
        <button className="aa-perm-submit" onClick={() => onResolve(options[sel].outcome)}>
          Submit <Ic.cornerReturn size={14} />
        </button>
      </div>
    </div>);

}

function renderHandles(text) {
  return text.split(/(@[a-z0-9-]+)/i).map((p, i) =>
  /^@[a-z0-9-]+$/i.test(p) ? <span className="aa-tok aa-tok-handle" key={i}>{p}</span> : p);
}

/* ============================ Choice card =================================== */
function ChoiceCard({ c, answered, onConfirm }) {
  const opts = c.options;
  const [sel, setSel] = useState(() => {
    const r = opts.findIndex((o) => o.recommended);
    return r >= 0 ? r : 0;
  });
  const onKey = (e) => {
    if (e.key === "ArrowDown") {e.preventDefault();setSel((s) => (s + 1) % opts.length);} else
    if (e.key === "ArrowUp") {e.preventDefault();setSel((s) => (s - 1 + opts.length) % opts.length);} else
    if (e.key === "Enter") {e.preventDefault();onConfirm(opts[sel].id);} else
    if (/^[1-9]$/.test(e.key)) {const i = +e.key - 1;if (i < opts.length) setSel(i);}
  };

  if (answered) {
    const idx = opts.findIndex((o) => o.id === answered);
    const opt = opts[idx];
    return (
      <div className="aa-perm is-answered">
        <div className="aa-perm-eyebrow answered">Answered</div>
        <div className="aa-perm-q">{c.title}</div>
        <div className="aa-perm-opts">
          <div className="aa-perm-opt has-desc is-sel">
            <span className="aa-perm-num">{idx + 1}.</span>
            <span className="aa-perm-label">
              <strong>{opt.title}</strong>
              <span>{opt.desc}</span>
            </span>
            <span className="aa-perm-done"><Ic.check size={15} /></span>
          </div>
        </div>
      </div>);

  }

  return (
    <div className="aa-perm" tabIndex={0} onKeyDown={onKey}>
      <div className="aa-perm-q">{c.title}</div>
      {c.body && <p className="aa-perm-sub">{c.body}</p>}
      <div className="aa-perm-opts" role="listbox">
        {opts.map((o, i) =>
        <button
          key={o.id}
          role="option"
          aria-selected={sel === i}
          className={`aa-perm-opt has-desc ${sel === i ? "is-sel" : ""}`}
          onMouseEnter={() => setSel(i)}
          onClick={() => setSel(i)}>
          <span className="aa-perm-num">{i + 1}.</span>
          <span className="aa-perm-label">
            <strong>{o.title}{o.recommended && <em className="aa-rec">Recommended</em>}</strong>
            <span>{o.desc}</span>
          </span>
          {sel === i &&
          <span className="aa-perm-keys"><Ic.arrowUp size={13} /><Ic.arrowDown size={13} /></span>}
        </button>
        )}
      </div>
      <div className="aa-perm-foot">
        <button className="aa-perm-skip" onClick={() => onConfirm((opts.find((o) => o.id === "skip") || opts[opts.length - 1]).id)}>Skip</button>
        <button className="aa-perm-submit" onClick={() => onConfirm(opts[sel].id)}>Submit <Ic.cornerReturn size={14} /></button>
      </div>
    </div>);

}

/* ============================ Worked / run summary ========================== */
function WorkedRow({ label }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="aa-worked-wrap">
      <button className="aa-worked" onClick={() => setOpen(!open)}>
        <Ic.spark size={13} /><span>Worked for {label}</span>
        <Ic.chevRight size={13} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
      </button>
      {open &&
      <div className="aa-worked-detail">
          Reproduced the flow in Electron via CDP, inspected caret/focus state after skill selection, and disabled
          native spellcheck while the highlight overlay is active. Ran <code>make typecheck</code> (0 errors).
        </div>
      }
    </div>);

}

/* ============================ Live run (in progress) ======================== */
function RunningRow({ run, onStop }) {
  const [elapsed, setElapsed] = useState(14);
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const mm = String(Math.floor(elapsed / 60));
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className="aa-running">
      <div className="aa-running-head">
        <span className="aa-running-dots" aria-hidden="true"><span></span><span></span><span></span></span>
        <span className="aa-running-title">{run.title}</span>
        <span className="aa-running-time">{mm}:{ss}</span>
      </div>
      {run.preview && <div className="aa-running-preview">{run.preview}</div>}
    </div>);

}

/* ============================ Message ======================================= */
function MsgActions({ onThread, running, onStop }) {
  return (
    <div className="aa-msg-actions">
      {running && <button className="aa-iconbtn aa-iconbtn-stop" title="Stop run" onClick={onStop}><Ic.x size={15} /></button>}
      <button className="aa-iconbtn" title="Copy"><Ic.copy size={15} /></button>
      <button className="aa-iconbtn" title="React"><Ic.smile size={15} /></button>
      {onThread && <button className="aa-iconbtn" title="Reply in thread" onClick={onThread}><Ic.reply size={15} /></button>}
    </div>);

}

function Message({ m, style, avatarMode, provAccent, onOpenThread, resolved, onResolve, answered, onAnswer, running, onStop }) {
  const p = PARTICIPANTS[m.author];
  const isUser = p.kind === "user";

  if (m.kind === "system") {
    return (
      <div className="aa-system">
        <span className="aa-system-dot" /><span className="aa-system-text">{renderInline(m.blocks[0].text)}</span>
        <span className="aa-system-time">{m.at}</span>
      </div>);

  }

  if (m.kind === "approval" && resolved) {
    return <ApprovalResolvedLine a={m.approval} outcome={resolved} at={m.at} onUndo={() => onResolve(null)} />;
  }

  const bubble = style === "bubble" || style === "hybrid" && isUser;
  const rightAlign = (style === "hybrid" || style === "bubble") && isUser;
  const showRail = provAccent && !isUser && (style === "flat" || style === "hybrid");
  const nameColor = provAccent && !isUser ? provVar(p.provider) : "var(--app-text-strong)";

  const body =
  <div className="aa-msg-body">
      <div className="aa-msg-meta">
        <strong style={{ color: nameColor }}>{isUser ? "You" : `@${p.handle}`}</strong>
        {!isUser && <span className="aa-msg-provider" style={provAccent ? { color: provVar(p.provider) } : undefined}>{PROVIDER_LABEL[p.provider]}</span>}
        <span className="aa-msg-time">{m.at}</span>
      </div>
      {m.worked && <WorkedRow label={m.worked} />}
      {m.running && (running
        ? <RunningRow run={m.running} onStop={onStop} />
        : <div className="aa-running-stopped"><Ic.square size={12} /> Stopped · {m.running.title.toLowerCase()}</div>)}
      <div className="aa-msg-content">
        <Blocks blocks={m.blocks} />
        {m.kind === "approval" && <ApprovalCard a={m.approval} onResolve={onResolve} />}
        {m.kind === "choice" && <ChoiceCard c={m.choice} answered={answered} onConfirm={onAnswer} />}
        {m.repoFiles &&
      <div className="aa-repofiles"><Ic.file size={13} /><span>Referenced: {m.repoFiles.map((f, i) => <code key={i}>{f}</code>)}</span></div>
      }
      </div>
      {!isUser && m.replies && m.replies.length > 0 &&
    <button className="aa-thread-pill" onClick={onOpenThread}>
          <span className="aa-thread-avs">{m.replies.map((r, i) => <Avatar key={i} p={PARTICIPANTS[r.author]} size={20} mode={avatarMode} radius={6} />)}</span>
          <span className="aa-thread-count">{m.replies.length} replies</span>
          <span className="aa-thread-last">Last reply {m.replies[m.replies.length - 1].at}</span>
        </button>
    }
      {!m.replies && !isUser && onOpenThread && <button className="aa-reply-link" onClick={onOpenThread}>Reply</button>}
    </div>;


  return (
    <div className={`aa-msg ${isUser ? "is-user" : "is-agent"} ${rightAlign ? "right" : ""} ${bubble ? "bubble" : "flat"} ${showRail ? "rail" : ""}`}
    style={showRail ? { "--rail": provVar(p.provider) } : undefined}>
      {!rightAlign && <div className="aa-msg-av"><Avatar p={p} size={style === "bubble" ? 36 : 38} mode={avatarMode} /></div>}
      <div className={`aa-msg-col ${running ? "is-running" : ""}`} style={bubble ? { "--bub": isUser ? "var(--app-user-bub)" : "var(--app-surface)" } : undefined}>
        {body}
        <MsgActions onThread={!isUser ? onOpenThread : null} running={running} onStop={onStop} />
      </div>
      {rightAlign && <div className="aa-msg-av"><Avatar p={p} size={style === "bubble" ? 36 : 38} mode={avatarMode} /></div>}
    </div>);

}

/* ============================ Sidebar ======================================= */
function Sidebar({ projects, activeChat, onPick, collapsed, onToggle }) {
  const [open, setOpen] = useState(() => Object.fromEntries(projects.map((p) => [p.id, p.open])));
  return (
    <aside className={`aa-sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="aa-traffic"><span className="tl red" /><span className="tl yellow" /><span className="tl green" /></div>
      <div className="aa-brand">
        <img className="aa-brand-mark" src="assets/mark.png" width="22" height="22" alt="" />
        <span className="aa-brand-name">AccordAgents</span>
        <button className="aa-iconbtn" title="Collapse sidebar" onClick={onToggle}><Ic.panelLeft size={17} /></button>
      </div>
      <button className="aa-newchat"><Ic.pencil size={15} />New chat</button>
      <div className="aa-side-scroll">
        <div className="aa-side-label">Projects</div>
        {projects.map((pr) =>
        <div className="aa-proj" key={pr.id}>
            <button className="aa-proj-head" onClick={() => setOpen({ ...open, [pr.id]: !open[pr.id] })}>
              {open[pr.id] ? <Ic.chevDown size={14} /> : <Ic.chevRight size={14} />}
              <span>{pr.name}</span>
            </button>
            {open[pr.id] &&
          <div className="aa-proj-chats">
                {pr.chats.map((c) =>
            <button key={c.id} className={`aa-chat ${activeChat === c.id ? "active" : ""}`} onClick={() => onPick(c.id)}>
                    <span className="aa-chat-title">{c.title}</span>
                    {c.live ? <span className="aa-chat-live" /> : <span className="aa-chat-when">{c.when}</span>}
                  </button>
            )}
                {pr.more && <button className="aa-showmore">Show {pr.more} more</button>}
              </div>
          }
          </div>
        )}
      </div>
      <button className="aa-side-foot"><Ic.settings size={16} /><span>Settings</span></button>
    </aside>);

}

/* ============================ Active-run banner ============================= */
function ActiveRunBar({ count, onStopAll }) {
  return (
    <div className="aa-runbar-wrap">
      {count > 0 &&
      <div className="aa-runbar">
        <span className="aa-runbar-left">
          <span className="aa-runbar-spin" aria-hidden="true" />
          {count} active run{count > 1 ? "s" : ""}
        </span>
        <button className="aa-runbar-stop" onClick={onStopAll}><Ic.x size={14} />Stop all</button>
      </div>}
    </div>);

}

/* ============================ Top bar ======================================= */
function TopBar({ title, participantIds, avatarMode, dark, onToggleTheme }) {
  return (
    <header className="aa-topbar">
      <div className="aa-topbar-title">
        <span>{title}</span>
        <button className="aa-iconbtn" title="Rename"><Ic.pencil size={15} /></button>
      </div>
      <div className="aa-topbar-actions">
        <div className="aa-roster">
          <div className="aa-roster-avs">
            {participantIds.filter((id) => id !== "you").slice(0, 4).map((id) =>
            <Avatar key={id} p={PARTICIPANTS[id]} size={26} mode={avatarMode} radius={7} />
            )}
          </div>
          <span className="aa-roster-count">{participantIds.length}</span>
        </div>
        <button className="aa-iconbtn" title="Toggle theme" onClick={onToggleTheme}>{dark ? <Ic.sun size={17} /> : <Ic.moon size={17} />}</button>
        <button className="aa-iconbtn" title="Settings"><Ic.settings size={17} /></button>
        <button className="aa-iconbtn" title="Refresh"><Ic.refresh size={17} /></button>
      </div>
    </header>);

}

/* ============================ Composer ===================================== */
const MENTION_DATA = {
  "@": [
  { k: "taylor", label: "taylor-claude-reviewer", sub: "Claude Code \u00b7 Reviewer" },
  { k: "drew", label: "drew-codex-engineer", sub: "Codex CLI \u00b7 Engineer" },
  { k: "nova", label: "nova-gemini-analyst", sub: "Gemini \u00b7 Analyst" },
  { k: "admin", label: "admin", sub: "Codex CLI \u00b7 Administrator" }],

  "/": [
  { label: "qa", sub: "Run the QA skill" },
  { label: "review", sub: "Structured code review" },
  { label: "skill-name", sub: "Invoke a named skill" }],

  "#": [
  { label: "src/renderer/components/chat/chat-composer.tsx", sub: "TypeScript" },
  { label: "src/main/services/chat.ts", sub: "TypeScript" },
  { label: "docs/chat-roles-and-participants.md", sub: "Markdown" }]

};

function Composer({ onSend, runCount = 0, onStopAll }) {
  const [val, setVal] = useState("");
  const [menu, setMenu] = useState(null); // {trigger, items}
  const taRef = useRef(null);

  function update(v) {
    setVal(v);
    const tok = v.match(/(^|\s)([@#/])([a-z0-9_./-]*)$/i);
    if (tok) {
      const trig = tok[2];
      const q = tok[3].toLowerCase();
      const items = (MENTION_DATA[trig] || []).filter((it) => it.label.toLowerCase().includes(q));
      setMenu(items.length ? { trigger: trig, items } : null);
    } else setMenu(null);
  }
  function pick(it) {
    const v = val.replace(/([@#/])([a-z0-9_./-]*)$/i, (mm, trig) => `${trig}${it.label} `);
    setVal(v);setMenu(null);taRef.current && taRef.current.focus();
  }
  function send() {
    if (!val.trim()) return;
    onSend(val.trim());setVal("");setMenu(null);
  }

  return (
    <div className="aa-composer">
      {menu &&
      <div className="aa-mention">
          <div className="aa-mention-label">
            {menu.trigger === "@" ? "Participants" : menu.trigger === "/" ? "Skills" : "Repository files"}
          </div>
          {menu.items.map((it, i) =>
        <button className="aa-mention-item" key={i} onClick={() => pick(it)}>
              {menu.trigger === "@" && it.k ? <Avatar p={PARTICIPANTS[it.k]} size={24} mode="animal" radius={7} /> :
          <span className="aa-mention-glyph">{menu.trigger === "/" ? <Ic.zap size={14} /> : <Ic.hash size={14} />}</span>}
              <span className="aa-mention-name">{menu.trigger}{it.label}</span>
              <span className="aa-mention-sub">{it.sub}</span>
            </button>
        )}
        </div>
      }
      <div className="aa-composer-shell">
        <textarea
          ref={taRef} className="aa-textarea" rows={1} value={val}
          placeholder="Mention participants with @name, skills with /name, or repo files with #path"
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {if (e.key === "Enter" && !e.shiftKey) {e.preventDefault();send();}}} />
        
        <div className="aa-composer-bar">
          <button className="aa-iconbtn"><Ic.image size={17} /></button>
          {runCount > 0 &&
          <button className="aa-runchip" onClick={onStopAll} title="Stop all active runs">
            <span className="aa-runchip-spin" aria-hidden="true" />
            <span className="aa-runchip-label">{runCount} active run{runCount > 1 ? "s" : ""}</span>
            <span className="aa-runchip-stop"><Ic.x size={13} /></span>
          </button>}
          <div className="aa-composer-spacer" />
          <button className="aa-send" disabled={!val.trim()} onClick={send}><Ic.arrowUp size={18} /></button>
        </div>
      </div>
    </div>);

}

/* ============================ Thread panel ================================= */
function ThreadPanel({ root, style, avatarMode, provAccent, onClose }) {
  if (!root) return null;
  const rp = PARTICIPANTS[root.author];
  return (
    <aside className="aa-thread">
      <div className="aa-thread-top">
        <div><strong>Thread</strong><span>{root.replies.length} replies</span></div>
        <button className="aa-iconbtn" onClick={onClose}><Ic.x size={18} /></button>
      </div>
      <div className="aa-thread-scroll">
        <div className="aa-thread-root">
          <Message m={{ ...root, replies: null }} style="flat" avatarMode={avatarMode} provAccent={provAccent} />
        </div>
        <div className="aa-thread-divider"><span>{root.replies.length} replies</span></div>
        {root.replies.map((r, i) =>
        <Message key={i} m={{ id: `r${i}`, author: r.author, at: r.at, blocks: r.blocks }} style="flat" avatarMode={avatarMode} provAccent={provAccent} />
        )}
      </div>
      <div className="aa-thread-composer">
        <Composer onSend={() => {}} />
      </div>
    </aside>);

}

Object.assign(window, { Avatar, Message, Sidebar, TopBar, Composer, ThreadPanel, ActiveRunBar, Ic });