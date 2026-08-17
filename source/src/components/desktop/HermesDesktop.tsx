"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  Eye,
  FileCode2,
  Files,
  Folder,
  Gauge,
  LockKeyhole,
  Menu,
  MessageSquare,
  Package,
  Pin,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  UserRoundCog,
  Users,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./HermesDesktop.module.css";
import { EXECUTION_FROZEN_COPY, isFrozenExecutionPath } from "@/lib/executionAvailability";
import {
  type HermesBucket,
  type HermesFile,
  type HermesSession,
  type HermesSessionGroup,
  useHermesDesktopData,
} from "./useHermesDesktopData";

type HermesView = "messages" | "profiles" | "projects" | "skills" | "mcps" | "artifacts" | "settings";
type HermesPane = "preview" | "files" | "review" | "terminal";
type HistoryFilter = "all" | "today" | "week" | "pinned" | "discord";

function discordSession(session: HermesSession): boolean {
  return [session.platform, session.channelSource, session.source, session.channel, session.chatType].some((value) => /discord/i.test(value ?? ""));
}

function channelLabel(session: HermesSession): string {
  const channel = session.channel?.trim();
  const type = session.chatType?.trim();
  if (channel) {
    if (/\bdm\b|direct/i.test(type ?? "") || channel.startsWith("#") || channel.includes("/#") || channel.includes("/ #")) return channel;
    return `#${channel}`;
  }
  return type && !/discord/i.test(type) ? type : "Direct message";
}

function sessionSearchText(session: HermesSession, group: HermesSessionGroup): string {
  return [
    session.name,
    session.preview,
    session.source,
    session.platform,
    session.channelSource,
    session.channel,
    session.chatType,
    group.label,
    group.root,
    group.scope,
    session.resumable === false ? "read only" : "resumable",
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function ago(ms: number): string {
  if (!ms) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 14 ? `${days}d` : new Date(ms).toLocaleDateString();
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function rtl(value: string): boolean {
  return (value.match(/[\u0590-\u08ff]/g) ?? []).length > (value.match(/[A-Za-z]/g) ?? []).length;
}

function profileInitial(name: string): string {
  return name.split(/[-_.]/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "H";
}

function StatusBlock({ state, title, error, onRetry }: { state: "loading" | "ready" | "empty" | "error" | "offline"; title: string; error?: string; onRetry?: () => void }) {
  if (state === "ready") return null;
  return <div className={styles.statusBlock} role={state === "error" ? "alert" : "status"}>
    {state === "loading" ? <RefreshCw className={styles.spin} size={20} /> : state === "error" ? <AlertTriangle size={20} /> : state === "offline" ? <Circle size={20} /> : <Sparkles size={20} />}
    <strong>{state === "loading" ? `Loading ${title}` : state === "error" ? `${title} unavailable` : state === "offline" ? "Hermes is offline" : `No ${title.toLowerCase()} yet`}</strong>
    <span>{state === "error" ? (error || "The local API returned an error.") : state === "offline" ? "Reconnect to the local Agent OS server, then retry." : state === "empty" ? `Hermes reported no ${title.toLowerCase()}.` : "Reading native Hermes state…"}</span>
    {onRetry && state !== "loading" && <button type="button" onClick={onRetry}><RefreshCw size={15} />Retry</button>}
  </div>;
}

export default function HermesDesktop() {
  const data = useHermesDesktopData();
  const [view, setView] = useState<HermesView>("messages");
  const [pane, setPane] = useState<HermesPane | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [input, setInput] = useState("");
  const [selectedFile, setSelectedFile] = useState<HermesFile | null>(null);
  const [fileText, setFileText] = useState("");
  const [fileError, setFileError] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [mcpMutation, setMcpMutation] = useState("");
  const [mcpMutationError, setMcpMutationError] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const paneTriggerRef = useRef<HTMLButtonElement | null>(null);
  const hydratingUrlRef = useRef(false);

  useFocusContainment(drawerOpen, drawerRef, () => setDrawerOpen(false), drawerTriggerRef);
  useFocusContainment(Boolean(pane), paneRef, () => setPane(null), paneTriggerRef, true);

  useEffect(() => {
    const hydrate = () => {
      hydratingUrlRef.current = true;
      const params = new URLSearchParams(window.location.search);
      const tab = (params.get("view") || params.get("tab")) as HermesView | null;
      const requestedPane = params.get("pane") as HermesPane | null;
      const legacy: Record<string, HermesView> = { chat: "messages", sessions: "messages", workspace: "projects", studio: "artifacts", manage: "settings", control: "settings" };
      setView(tab && (["messages", "profiles", "projects", "skills", "mcps", "artifacts", "settings"] as string[]).includes(tab) ? tab : tab && legacy[tab] ? legacy[tab] : "messages");
      setPane(requestedPane && (["preview", "files", "review", "terminal"] as string[]).includes(requestedPane) ? requestedPane : null);
    };
    hydrate();
    window.addEventListener("popstate", hydrate);
    return () => window.removeEventListener("popstate", hydrate);
  }, []);

  useEffect(() => {
    const onNavigation = (event: Event) => {
      const detail = (event as CustomEvent<{ agent?: string; target?: string; section?: string }>).detail;
      if (detail?.agent !== "hermes") return;
      const target = detail.target ?? detail.section;
      if (target === "new") data.createSession();
      else if (target === "profiles") setView("profiles");
      else if (target === "workspace" || target === "projects") setView("projects");
      else if (target === "studio" || target === "artifacts") setView("artifacts");
      else if (target === "mcps" || target === "tools") setView("mcps");
      else if (target === "manage" || target === "control") setView("settings");
      else setView("messages");
    };
    window.addEventListener("agent-workspace-nav", onNavigation);
    return () => window.removeEventListener("agent-workspace-nav", onNavigation);
  }, [data]);

  useEffect(() => {
    if (hydratingUrlRef.current) {
      hydratingUrlRef.current = false;
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    if (pane) url.searchParams.set("pane", pane); else url.searchParams.delete("pane");
    if (url.href !== window.location.href) window.history.pushState(window.history.state, "", url);
  }, [pane, view]);

  useEffect(() => {
    if (data.activeGroup) setExpandedGroups((current) => new Set(current).add(data.activeGroup!.id));
  }, [data.activeGroup]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [data.messages, data.sending]);

  const profileGroups = useMemo(() => data.groups.filter((group) => (group.scope || "default") === data.selectedProfile), [data.groups, data.selectedProfile]);

  const filteredGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const now = Date.now();
    let remaining = visibleLimit;
    return profileGroups.flatMap((group) => {
      const sessions = group.sessions.filter((session) => {
        if (normalized && !sessionSearchText(session, group).includes(normalized)) return false;
        if (historyFilter === "pinned") return data.pins.includes(session.path);
        if (historyFilter === "discord") return discordSession(session);
        if (historyFilter === "today") return now - session.mtime < 86_400_000;
        if (historyFilter === "week") return now - session.mtime < 604_800_000;
        return true;
      }).sort((a, b) => Number(data.pins.includes(b.path)) - Number(data.pins.includes(a.path)) || b.mtime - a.mtime);
      if (!sessions.length || remaining <= 0) return [];
      const visible = sessions.slice(0, remaining);
      remaining -= visible.length;
      return [{ ...group, sessions: visible }];
    });
  }, [data.pins, historyFilter, profileGroups, query, visibleLimit]);

  const filteredTotal = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const now = Date.now();
    return profileGroups.reduce((count, group) => count + group.sessions.filter((session) => {
      if (normalized && !sessionSearchText(session, group).includes(normalized)) return false;
      if (historyFilter === "pinned") return data.pins.includes(session.path);
      if (historyFilter === "discord") return discordSession(session);
      if (historyFilter === "today") return now - session.mtime < 86_400_000;
      if (historyFilter === "week") return now - session.mtime < 604_800_000;
      return true;
    }).length, 0);
  }, [data.pins, historyFilter, profileGroups, query]);

  function chooseView(next: HermesView) {
    setView(next);
    if (next === "projects" || next === "artifacts") setPane("files");
    setDrawerOpen(false);
  }

  function chooseSession(session: HermesSession, group: HermesSessionGroup) {
    void data.openSession(session, group);
    setView("messages");
    setDrawerOpen(false);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || !data.activeSession) return;
    const result = data.submitMessage(text);
    if (result.accepted) setInput("");
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  async function openFile(file: HermesFile, bucket?: HermesBucket) {
    const selectedBucket = bucket ?? data.activeBucket;
    if (!selectedBucket) return;
    setSelectedFile(file);
    setFileText("");
    setFileError("");
    setPane("preview");
    if (file.kind !== "text") return;
    setFileLoading(true);
    try {
      const response = await fetch(`/api/hermes/workspace/file?bucket=${encodeURIComponent(selectedBucket.id)}&path=${encodeURIComponent(file.relPath)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(String(payload.error ?? response.statusText));
      setFileText(payload.content ?? "");
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileLoading(false);
    }
  }

  const previewUrl = selectedFile && data.activeBucket ? `/api/hermes/preview/${encodeURIComponent(data.activeBucket.id)}/${selectedFile.relPath.split(/[\\/]/).map(encodeURIComponent).join("/")}` : "";
  const lockedProfile = data.activeGroup?.scope || data.selectedProfile;
  const activeProfile = data.profiles.find((profile) => profile.name === lockedProfile);

  return (
    <div data-agent-page="hermes" data-agent-experience="immersive" data-pane-open={Boolean(pane)} className={styles.shell}>
      <header className={styles.mobileHeader}>
        <button ref={drawerTriggerRef} type="button" aria-label="Open Hermes navigation" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}><Menu size={20} /></button>
        <div><span className={styles.hermesMark}>H</span><strong>Hermes</strong><small>{lockedProfile}</small></div>
        <button type="button" aria-label="New Hermes session" onClick={() => data.createSession()}><Plus size={20} /></button>
      </header>

      {drawerOpen && <button type="button" aria-label="Close navigation" className={styles.backdrop} onClick={() => setDrawerOpen(false)} />}
      <aside ref={drawerRef} className={`${styles.sidebar} ${drawerOpen ? styles.sidebarOpen : ""}`} aria-label="Hermes profiles and conversations" aria-modal={drawerOpen || undefined} role={drawerOpen ? "dialog" : undefined} tabIndex={-1}>
        <div className={styles.sidebarHead}>
          <div className={styles.brand}><span className={styles.hermesMark}>H</span><div><strong>Hermes</strong><span>Desktop agent</span></div></div>
          <button type="button" className={styles.closeDrawer} aria-label="Close navigation" onClick={() => setDrawerOpen(false)}><X size={18} /></button>
        </div>

        <div className={styles.profileContext}>
          <label htmlFor="hermes-profile">Agent profile</label>
          <div>
            <select id="hermes-profile" value={lockedProfile} disabled={data.profileLocked} onChange={(event) => data.setSelectedProfile(event.target.value)}>{data.profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}</select>
            {data.profileLocked ? <LockKeyhole size={15} /> : <ChevronDown size={15} />}
          </div>
          <small>{data.profileLocked ? "Locked to this session. Start a new chat to change agent." : "A new session keeps this profile for its lifetime."}</small>
        </div>

        <button type="button" className={styles.newMessage} onClick={() => data.createSession()}><Plus size={17} />New message</button>

        <nav className={styles.nav} aria-label="Hermes desktop sections">
          <button type="button" data-active={view === "messages"} onClick={() => chooseView("messages")}><MessageSquare size={17} /><span>Messaging</span>{data.queue.length > 0 && <small>{data.queue.length}</small>}</button>
          <button type="button" data-active={view === "profiles"} onClick={() => chooseView("profiles")}><Users size={17} /><span>Agents</span><small>{data.profiles.length}</small></button>
          <button type="button" data-active={view === "projects"} onClick={() => chooseView("projects")}><Folder size={17} /><span>Projects</span><small>{data.buckets.length}</small></button>
          <button type="button" data-active={view === "skills"} onClick={() => chooseView("skills")}><Sparkles size={17} /><span>Skills</span></button>
          <button type="button" data-active={view === "artifacts"} onClick={() => chooseView("artifacts")}><Package size={17} /><span>Artifacts</span></button>
          <button type="button" data-active={view === "mcps"} onClick={() => chooseView("mcps")}><Plug size={17} /><span>MCPs</span><small>{data.mcps.filter((item) => item.enabled).length}</small></button>
          <button type="button" data-active={view === "settings"} onClick={() => chooseView("settings")}><Settings size={17} /><span>Settings</span></button>
        </nav>

        {view === "messages" && <>
          <div className={styles.historyTools}>
            <label><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleLimit(80); }} placeholder="Search conversations" aria-label="Search conversations" /></label>
            <select value={historyFilter} onChange={(event) => { setHistoryFilter(event.target.value as HistoryFilter); setVisibleLimit(80); }} aria-label="Filter conversations"><option value="all">All</option><option value="today">Today</option><option value="week">7 days</option><option value="pinned">Pinned</option><option value="discord">Discord</option></select>
          </div>
          <div className={styles.historyLabel}><span>Profile conversations</span><span>{filteredTotal} / {profileGroups.reduce((count, group) => count + group.sessions.length, 0)}</span></div>
          <div className={styles.historyList}>
            <StatusBlock state={data.historyState} title="Sessions" error={data.historyError} onRetry={() => void data.loadHistory()} />
            {filteredGroups.map((group) => {
              const expanded = expandedGroups.has(group.id);
              return <section key={group.id} className={styles.group}>
                <button type="button" className={styles.groupButton} onClick={() => setExpandedGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                  return next;
                })} aria-expanded={expanded} aria-label={`${group.label}: ${group.sessions.length} conversations`}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span className={styles.profileMini}>{profileInitial(group.scope || "default")}</span><span title={group.root}>{group.label}</span><small>{group.sessions.length}</small></button>
                {expanded && <div className={styles.sessions}>{group.sessions.map((session) => {
                  const pinned = data.pins.includes(session.path);
                  const isDiscord = discordSession(session);
                  return <div key={session.path} className={styles.session} data-active={data.activeSession?.path === session.path} data-source={isDiscord ? "discord" : undefined}>
                    <button type="button" onClick={() => chooseSession(session, group)}><span className={styles.sessionTitle}>{session.name}</span>{isDiscord && <span className={styles.discordSource}><strong>Discord</strong><span>{channelLabel(session)}</span></span>}<small>{ago(session.mtime)} · {session.resumable === false ? "Read only" : "Resume"}</small></button>
                    <button type="button" className={styles.pin} data-pinned={pinned} aria-label={pinned ? `Unpin ${session.name}` : `Pin ${session.name}`} onClick={() => data.togglePin(session.path)}><Pin size={14} fill={pinned ? "currentColor" : "none"} /></button>
                  </div>;
                })}</div>}
              </section>;
            })}
            {filteredTotal > visibleLimit && <button type="button" className={styles.loadMore} onClick={() => setVisibleLimit((limit) => limit + 80)}>Load {Math.min(80, filteredTotal - visibleLimit)} more · {filteredTotal - visibleLimit} remaining</button>}
            {data.historyState === "ready" && filteredTotal === 0 && <div className={styles.noResults}>No matching conversations.</div>}
          </div>
        </>}

        <div className={styles.sidebarBottom}>
          <span data-online={data.online && data.vitals?.ok === true} />
          <div><strong>{data.vitals?.ok ? "Hermes online" : data.online ? "Setup required" : "Offline"}</strong><small>{data.vitals?.model || data.source || "Local runtime"}</small></div>
          <button type="button" onClick={() => void Promise.all([data.loadHistory(), data.loadVitals()])} aria-label="Refresh Hermes"><RefreshCw size={16} /></button>
        </div>
      </aside>

      <main className={styles.main}>
        <div className={styles.titlebar}>
          <div><span>{view === "messages" ? activeProfile?.description || "Hermes messaging" : "Hermes desktop"}</span><strong>{view === "messages" ? data.activeSession?.name || "New conversation" : view === "profiles" ? "Agent profiles" : view === "projects" ? "Projects" : view === "skills" ? "Skills" : view === "artifacts" ? "Artifacts" : view === "mcps" ? "MCP servers" : "Settings"}</strong></div>
          <div className={styles.titleContext}><span><LockKeyhole size={14} />{lockedProfile}</span><span><Bot size={14} />{activeProfile?.model || data.vitals?.model || "Hermes model"}</span></div>
        </div>

        {view === "messages" && <MessageView data={data} input={input} setInput={setInput} submit={submit} composerKeyDown={composerKeyDown} transcriptRef={transcriptRef} />}
        {view === "profiles" && <ProfilesView data={data} />}
        {view === "projects" && <ProjectsView data={data} onFile={openFile} />}
        {view === "artifacts" && <ProjectsView data={data} onFile={openFile} artifactMode />}
        {view === "skills" && <SkillsView data={data} />}
        {view === "mcps" && <McpsView data={data} mutation={mcpMutation} setMutation={setMcpMutation} mutationError={mcpMutationError} setMutationError={setMcpMutationError} />}
        {view === "settings" && <SettingsView data={data} />}
      </main>

      <aside className={styles.paneRail} aria-label="Hermes tools">
        {([[
          "preview", Eye,
        ], ["files", Files], ["review", CheckCircle2], ["terminal", Terminal]] as [HermesPane, typeof Eye][]).map(([key, Icon]) => <button type="button" key={key} data-active={pane === key} onClick={(event) => { paneTriggerRef.current = event.currentTarget; setPane((current) => current === key ? null : key); }} title={key[0].toUpperCase() + key.slice(1)} aria-label={key}><Icon size={19} /></button>)}
      </aside>

      {pane && <section ref={paneRef} className={styles.pane} aria-label={`${pane} pane`} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className={styles.paneHeader}><div><span>Hermes</span><strong>{pane[0].toUpperCase() + pane.slice(1)}</strong></div><button type="button" aria-label="Close pane" onClick={() => setPane(null)}><X size={18} /></button></div>
        <div className={styles.paneBody}>
          {(pane === "review" || pane === "terminal") && <div className={styles.unsupported}>{pane === "review" ? <CheckCircle2 size={25} /> : <Terminal size={25} />}<h2>{pane === "review" ? "Review state is unavailable" : "Terminal is unavailable"}</h2><p>Current Hermes APIs do not expose a verified {pane} stream. Agent OS does not simulate one.</p><span>Unsupported</span></div>}
          {pane === "files" && <WorkspacePane data={data} onFile={openFile} />}
          {pane === "preview" && <FilePreview file={selectedFile} url={previewUrl} text={fileText} loading={fileLoading} error={fileError} />}
        </div>
      </section>}

      <footer className={styles.statusBar}>
        <span><i data-online={data.online && data.vitals?.ok === true} />{data.vitals?.ok ? "Connected" : data.online ? "Runtime unavailable" : "Offline"}</span>
        <span>Profile <strong>{lockedProfile}</strong></span>
        <span>Model <strong>{activeProfile?.model || data.vitals?.model || "unknown"}</strong></span>
        <span>{data.queue.length} queued</span>
        <span className={styles.statusRight}>{data.vitals?.provider || "local"}{typeof data.vitals?.latencyMs === "number" ? ` · ${data.vitals.latencyMs}ms` : ""}</span>
      </footer>
    </div>
  );
}

function MessageView({ data, input, setInput, submit, composerKeyDown, transcriptRef }: { data: ReturnType<typeof useHermesDesktopData>; input: string; setInput: (value: string) => void; submit: (event?: FormEvent) => void; composerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void; transcriptRef: React.RefObject<HTMLDivElement | null> }) {
  return <div className={styles.messageStage}>
    <div ref={transcriptRef} className={styles.transcript} tabIndex={0} aria-label="Hermes conversation transcript">
      {!data.activeSession && <div className={styles.welcome}><span className={styles.largeMark}>H</span><h1>How can Hermes help?</h1><p>Select a conversation, or begin a new session with a profile. Profile identity cannot change after the session starts.</p><button type="button" onClick={() => data.createSession()}><Plus size={17} />Start a session</button></div>}
      {data.activeSession && <StatusBlock state={data.transcriptState} title="Messages" error={data.transcriptError} />}
      {data.activeSession && <div className={styles.messages}>{data.messages.map((message, index) => <article key={`${message.ts}-${index}`} data-role={message.role} dir={rtl(message.text) ? "rtl" : "auto"}><div className={styles.messageMeta}><span>{message.role === "user" ? "You" : "Hermes"}</span><time>{new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><div className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown></div></article>)}
        {data.sending && <article data-role="assistant"><div className={styles.messageMeta}><span>Hermes</span><span className={styles.working}>Working</span></div><div className={styles.thinking}><span /><span /><span /></div></article>}
      </div>}
      {data.sendError && <div className={styles.inlineError} role="alert"><AlertTriangle size={17} />{data.sendError}</div>}
    </div>
    {data.queue.length > 0 && <div className={styles.queueBar}><div><Boxes size={16} /><strong>Queue · {data.queue.length}</strong><span>Messages run in order for profile {data.activeGroup?.scope || data.selectedProfile}.</span></div><div>{data.queue.map((item, index) => <span key={item.id}><small>{index + 1}</small>{item.text}<button type="button" onClick={() => data.removeQueued(item.id)} aria-label={`Remove queued message ${index + 1}`}><X size={14} /></button></span>)}</div></div>}
    {isFrozenExecutionPath("/api/hermes/chat")
      ? <div className={styles.composerWrap}>
          <div className={styles.unsupported} aria-label="Hermes send unavailable">
            <Send size={25} />
            <h2>Sending from Agent OS is disabled</h2>
            <p>{EXECUTION_FROZEN_COPY.body} Hermes lifecycle parity is a later wave of the repair; until it lands, run Hermes from its own CLI and read its sessions here.</p>
            <span>Unsupported</span>
          </div>
        </div>
      : <form className={styles.composerWrap} onSubmit={submit}>
      <div className={styles.composer} data-disabled={!data.activeSession || data.activeSession.resumable === false}>
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={composerKeyDown} disabled={!data.activeSession || data.activeSession.resumable === false} placeholder={!data.activeSession ? "Start or select a session first" : data.activeSession.resumable === false ? "This transcript is read only" : data.sending ? "Add another message to the queue…" : "Message Hermes…"} rows={2} dir="auto" aria-label="Message Hermes" />
        <div><span>{data.profileLocked ? <LockKeyhole size={14} /> : <UserRoundCog size={14} />}{data.activeGroup?.scope || data.selectedProfile} · {data.activeGroup?.root || "Hermes workspace"}</span><button type="submit" disabled={!input.trim() || !data.activeSession}><Send size={16} />{data.sending ? "Queue" : "Send"}</button></div>
      </div>
      {data.sending && <p>Hermes runtime does not expose safe cancellation here. Closing request would not prove process stopped.</p>}
    </form>}
  </div>;
}

function ProfilesView({ data }: { data: ReturnType<typeof useHermesDesktopData> }) {
  return <div className={styles.contentPage}>
    <div className={styles.pageHeading}><div><Users size={22} /><h1>Agent profiles</h1><p>Native profiles from <code>~/.hermes/profiles</code>. Each profile keeps separate sessions, model, memory, and SOUL.</p></div><button type="button" onClick={() => void data.loadProfiles()}><RefreshCw size={15} />Refresh</button></div>
    <StatusBlock state={data.profilesState} title="Profiles" onRetry={() => void data.loadProfiles()} />
    <div className={styles.profileGrid}>{data.profiles.map((profile) => <article key={profile.name} data-active={profile.active}><div className={styles.profileAvatar}>{profileInitial(profile.name)}</div><div className={styles.profileTitle}><strong>{profile.name}</strong>{profile.active && <span><CheckCircle2 size={13} />Active</span>}</div><p>{profile.description || profile.soul || "No description provided."}</p><dl><div><dt>Model</dt><dd>{profile.model}</dd></div><div><dt>Provider</dt><dd>{profile.provider || "inherited"}</dd></div><div><dt>Sessions</dt><dd>{profile.sessions}</dd></div><div><dt>Last active</dt><dd>{ago(profile.lastActive)}</dd></div></dl><button type="button" onClick={() => data.createSession(profile.name)}><MessageSquare size={16} />New session as {profile.name}</button></article>)}</div>
  </div>;
}

function ProjectsView({ data, onFile, artifactMode = false }: { data: ReturnType<typeof useHermesDesktopData>; onFile: (file: HermesFile, bucket?: HermesBucket) => Promise<void>; artifactMode?: boolean }) {
  const buckets = artifactMode ? data.buckets.filter((bucket) => /image|audio|video|app|goal|paste|studio|artifact/i.test(`${bucket.id} ${bucket.label}`)) : data.buckets;
  return <div className={styles.contentPage}>
    <div className={styles.pageHeading}><div>{artifactMode ? <Package size={22} /> : <Folder size={22} />}<h1>{artifactMode ? "Artifacts" : "Projects"}</h1><p>{artifactMode ? "Generated deliverables reported by Hermes workspace buckets." : "Real workspace buckets, sandboxes, and project outputs."}</p></div><button type="button" onClick={() => void data.loadWorkspace()}><RefreshCw size={15} />Refresh</button></div>
    <StatusBlock state={data.workspaceState} title={artifactMode ? "Artifacts" : "Projects"} error={data.workspaceError} onRetry={() => void data.loadWorkspace()} />
    <div className={styles.bucketGrid}>{buckets.map((bucket) => <button type="button" key={bucket.id} data-active={data.activeBucket?.id === bucket.id} onClick={() => { data.selectWorkspaceBucket(bucket); }}><span>{artifactMode ? <Package size={18} /> : <Folder size={18} />}</span><strong>{bucket.label}</strong><p>{bucket.description}</p><small>{bucket.fileCount} files · {ago(bucket.mtime)}</small><ChevronRight size={16} /></button>)}</div>
    {data.activeBucket && <div className={styles.projectFiles}><div><strong>{data.activeBucket.label}</strong><span>{data.workspaceFiles.length} files</span></div>{data.workspaceFiles.map((file) => <button type="button" key={file.relPath} onClick={() => void onFile(file, data.activeBucket!)}><FileCode2 size={16} /><span>{file.relPath}</span><small>{size(file.bytes)} · {ago(file.mtime)}</small><Eye size={15} /></button>)}</div>}
  </div>;
}

function SkillsView({ data }: { data: ReturnType<typeof useHermesDesktopData> }) {
  return <div className={styles.contentPage}>
    <div className={styles.pageHeading}><div><Sparkles size={22} /><h1>Skills</h1><p>Native output from <code>hermes skills list</code>. Agent OS does not infer unreported skills.</p></div><button type="button" onClick={() => void data.loadSkills()}><RefreshCw size={15} />Refresh</button></div>
    <StatusBlock state={data.skillsState} title="Skills" error={data.skillsState === "error" ? data.skillsOutput : undefined} onRetry={() => void data.loadSkills()} />
    {data.skillsState === "ready" && <pre className={styles.nativeOutput}>{data.skillsOutput}</pre>}
  </div>;
}

function McpsView({ data, mutation, setMutation, mutationError, setMutationError }: { data: ReturnType<typeof useHermesDesktopData>; mutation: string; setMutation: (value: string) => void; mutationError: string; setMutationError: (value: string) => void }) {
  async function toggle(item: (typeof data.mcps)[number]) {
    setMutation(item.name);
    setMutationError("");
    try { await data.toggleMcp(item); }
    catch (error) { setMutationError(error instanceof Error ? error.message : String(error)); }
    finally { setMutation(""); }
  }
  return <div className={styles.contentPage}>
    <div className={styles.pageHeading}><div><Plug size={22} /><h1>MCP servers</h1><p>Installed and catalogue MCPs for profile <strong>{data.selectedProfile}</strong>.</p></div><button type="button" onClick={() => void data.loadMcps()}><RefreshCw size={15} />Refresh</button></div>
    <StatusBlock state={data.mcpState} title="MCP servers" error={data.mcpError} onRetry={() => void data.loadMcps()} />
    {mutationError && <div className={styles.inlineError}><AlertTriangle size={17} />{mutationError}</div>}
    <div className={styles.mcpGrid}>{data.mcps.map((item) => <article key={item.name}><div><span data-enabled={item.enabled}><Plug size={17} /></span><div><strong>{item.name}</strong><small>{item.transport} · {item.authType || "auth not declared"}</small></div><button type="button" role="switch" aria-checked={item.enabled} disabled={mutation === item.name} onClick={() => void toggle(item)}><i />{mutation === item.name ? "Saving" : item.enabled ? "Enabled" : "Disabled"}</button></div><p>{item.command || item.url || "Native Hermes MCP configuration"}</p>{typeof item.toolCount === "number" && <small>{item.toolCount} selected tools</small>}</article>)}</div>
    <h2 className={styles.sectionTitle}>Catalogue · {data.mcpCatalog.length}</h2>
    <div className={styles.catalogList}>{data.mcpCatalog.map((item) => <article key={item.name}><div><strong>{item.name}</strong><span>{item.status}</span></div><p>{item.description}</p><small>{item.transportType || "transport unknown"} · {item.authType || "auth unknown"}</small>{item.source && <a href={item.source} target="_blank" rel="noreferrer"><ExternalLink size={14} />Source</a>}</article>)}</div>
  </div>;
}

function SettingsView({ data }: { data: ReturnType<typeof useHermesDesktopData> }) {
  return <div className={styles.contentPage}>
    <div className={styles.pageHeading}><div><Settings size={22} /><h1>Settings</h1><p>Local Hermes runtime, provider, profile, and dashboard status. No embedded iframe.</p></div><button type="button" onClick={() => void Promise.all([data.loadVitals(), data.loadDashboard(), data.loadProfiles()])}><RefreshCw size={15} />Refresh</button></div>
    <div className={styles.settingsGrid}>
      <article><Gauge size={20} /><span>Runtime</span><strong>{data.vitals?.ok ? "Connected" : "Unavailable"}</strong><p>{data.vitals?.raw || "No runtime status was returned."}</p></article>
      <article><Bot size={20} /><span>Model</span><strong>{data.vitals?.model || "unknown"}</strong><p>{data.vitals?.provider || "Provider not reported"}</p></article>
      <article><UserRoundCog size={20} /><span>Profile</span><strong>{data.selectedProfile}</strong><p>{data.profileLocked ? "Locked to the active session." : "Will be assigned to the next session."}</p></article>
      <article><Wrench size={20} /><span>Hermes dashboard</span><strong>{data.dashboard?.running ? "Running" : "Not running"}</strong><p>{data.dashboard?.error || data.dashboard?.url || "Native settings are shown in Agent OS."}</p>{data.dashboard?.running && data.dashboard.url && <a href={data.dashboard.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open native dashboard</a>}</article>
    </div>
  </div>;
}

function WorkspacePane({ data, onFile }: { data: ReturnType<typeof useHermesDesktopData>; onFile: (file: HermesFile, bucket?: HermesBucket) => Promise<void> }) {
  return <div className={styles.workspacePane}><div className={styles.paneControls}><select value={data.activeBucket?.id ?? ""} onChange={(event) => data.selectWorkspaceBucket(data.buckets.find((bucket) => bucket.id === event.target.value) ?? null)}>{data.buckets.map((bucket) => <option key={bucket.id} value={bucket.id}>{bucket.label} · {bucket.fileCount}</option>)}</select><button type="button" onClick={() => void data.loadWorkspace()}><RefreshCw size={15} />Refresh</button></div><StatusBlock state={data.workspaceState} title="Files" error={data.workspaceError} onRetry={() => void data.loadWorkspace()} />{data.workspaceFiles.map((file) => <button type="button" key={file.relPath} onClick={() => void onFile(file, data.activeBucket ?? undefined)}><FileCode2 size={16} /><span>{file.relPath}</span><small>{size(file.bytes)}</small></button>)}</div>;
}

function FilePreview({ file, url, text, loading, error }: { file: HermesFile | null; url: string; text: string; loading: boolean; error: string }) {
  if (!file) return <div className={styles.statusBlock}><Eye size={22} /><strong>No file selected</strong><span>Choose a real Hermes workspace file to preview.</span></div>;
  return <div className={styles.preview}><div><strong>{file.relPath}</strong><a href={url} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a></div>{loading && <div className={styles.statusBlock}><RefreshCw className={styles.spin} size={20} /><strong>Loading preview</strong></div>}{error && <div className={styles.inlineError}><AlertTriangle size={17} />{error}</div>}{!loading && !error && file.kind === "text" && (/\.html?$/i.test(file.relPath) ? <iframe src={url} title={file.name} sandbox="allow-scripts allow-forms allow-popups allow-modals" /> : <pre dir="auto">{text}</pre>)}{!loading && file.kind === "image" && <img src={url} alt={file.name} />}{!loading && file.kind === "video" && <video src={url} controls />}{!loading && file.kind === "audio" && <audio src={url} controls />}{!loading && (file.kind === "pdf" || file.kind === "binary") && <a className={styles.openFile} href={url} target="_blank" rel="noreferrer"><ExternalLink size={16} />Open file</a>}</div>;
}

function useFocusContainment(
  open: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  close: () => void,
  returnRef: React.RefObject<HTMLElement | null>,
  mobileOnly = false,
) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!open || (mobileOnly && !window.matchMedia("(max-width: 900px)").matches)) return;
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : returnRef.current;
    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    (focusables()[0] ?? container).focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      requestAnimationFrame(() => (returnRef.current ?? previouslyFocused)?.focus());
    };
  }, [containerRef, mobileOnly, open, returnRef]);
}
