import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRightLeft, Boxes, Check, ChevronDown, CircleAlert, Clock3, Copy, LayoutDashboard, LogOut, Plus, Search, Settings, Shield, Users, X } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { hasSupabaseConfig, supabase } from "./lib/supabase";
import { searchCards, toCardSnapshot, type RiftCard } from "./lib/cards";

type Pool = { id: string; name: string; role: "admin" | "member" };
type Member = { user_id: string; role: string; display_name: string; email: string };
type CopyRow = {
  id: string; pool_id: string; card_id: string; card_name: string; set_id: string;
  image_url: string; collector_number: number | null; rarity: string;
  owner_id: string; holder_id: string; deck_id: string | null;
};
type Deck = { id: string; name: string; status: "active" | "archived" };
type RequestRow = { id: string; deck_id: string; card_id: string; card_name: string; quantity: number };
type Loan = { id: string; copy_id: string; status: string; from_holder: string; to_holder: string; return_from: string | null; return_to: string | null; card_name?: string };
type Audit = { id: string; event_type: string; created_at: string; copy_id: string; details: Record<string, string> };

function message(error: unknown) {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pools, setPools] = useState<Pool[]>([]);
  const [pool, setPool] = useState<Pool | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [copies, setCopies] = useState<CopyRow[]>([]);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [tab, setTab] = useState("inventory");
  const [filter, setFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [holderFilter, setHolderFilter] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState("");
  const [deckFilter, setDeckFilter] = useState("");
  const [cardSearch, setCardSearch] = useState("");
  const [cardResults, setCardResults] = useState<RiftCard[]>([]);
  const [cardSearchLoading, setCardSearchLoading] = useState(false);
  const [requestSearchDeck, setRequestSearchDeck] = useState("");
  const [selectedCard, setSelectedCard] = useState<RiftCard | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [newPoolName, setNewPoolName] = useState("");
  const [newDeckName, setNewDeckName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteId, setInviteId] = useState("");
  const [allocation, setAllocation] = useState({ deck: "", card: "", copy: "" });

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data, error: authError }) => {
      if (authError) setError(authError.message);
      setSession(data.session);
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setPools([]);
      setPool(null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const loadPools = useCallback(async () => {
    if (!supabase || !session) return;
    const { data, error: queryError } = await supabase
      .from("pool_members").select("pool_id, role, pools(id,name)").eq("user_id", session.user.id);
    if (queryError) throw queryError;
    const available = (data ?? []).map((row) => {
      const details = row.pools as unknown as { id: string; name: string };
      return { id: details.id, name: details.name, role: row.role as Pool["role"] };
    });
    setPools(available);
    setPool((current) => available.find((item) => item.id === current?.id) ?? available[0] ?? null);
  }, [session]);

  const refresh = useCallback(async () => {
    if (!supabase || !pool) return;
    const results = await Promise.all([
      supabase.from("pool_members").select("user_id,role,profiles(display_name,email)").eq("pool_id", pool.id),
      supabase.from("copies").select("*").eq("pool_id", pool.id).order("created_at", { ascending: false }),
      supabase.from("decks").select("id,name,status").eq("pool_id", pool.id).order("created_at", { ascending: false }),
      supabase.from("deck_requests").select("id,deck_id,card_id,card_name,quantity").eq("pool_id", pool.id),
      supabase.from("loan_requests").select("id,copy_id,status,from_holder,to_holder,return_from,return_to,copies(card_name)").eq("pool_id", pool.id).order("created_at", { ascending: false }),
      supabase.from("audit_log").select("id,event_type,created_at,copy_id,details").eq("pool_id", pool.id).order("created_at", { ascending: false }).limit(100),
    ]);
    for (const result of results) if (result.error) throw result.error;
    setMembers((results[0].data ?? []).map((row) => {
      const profile = row.profiles as unknown as { display_name: string | null; email: string | null } | null;
      return { user_id: row.user_id, role: row.role, display_name: profile?.display_name || profile?.email || row.user_id.slice(0, 8), email: profile?.email ?? "" };
    }));
    setCopies((results[1].data ?? []) as CopyRow[]);
    setDecks((results[2].data ?? []) as Deck[]);
    setRequests((results[3].data ?? []) as RequestRow[]);
    setLoans((results[4].data ?? []).map((row) => ({ ...row, card_name: (row.copies as unknown as { card_name: string } | null)?.card_name })) as Loan[]);
    setAudit((results[5].data ?? []) as Audit[]);
  }, [pool]);

  useEffect(() => {
    if (!session) return;
    setBusy(true);
    loadPools().catch((e) => setError(message(e))).finally(() => setBusy(false));
  }, [session, loadPools]);

  useEffect(() => {
    if (!pool) return;
    setBusy(true);
    refresh().catch((e) => setError(message(e))).finally(() => setBusy(false));
  }, [pool, refresh]);

  const withBusy = async (action: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (!supabase) throw new Error("Supabase is not configured.");
    const { error: rpcError } = await supabase.rpc(name, args);
    if (rpcError) throw rpcError;
  };

  useEffect(() => {
    if (selectedCard || cardSearch.trim().length < 2) { setCardResults([]); setCardSearchLoading(false); return; }
    setCardResults([]);
    setCardSearchLoading(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchCards(cardSearch.trim(), controller.signal).then(setCardResults).catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setError(message(e));
      }).finally(() => { if (!controller.signal.aborted) setCardSearchLoading(false); });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [cardSearch, selectedCard]);

  const memberName = (id: string) => members.find((item) => item.user_id === id)?.display_name ?? "Unknown member";
  const deckName = (id: string | null) => decks.find((item) => item.id === id)?.name ?? "Unallocated";
  const filteredCopies = useMemo(() => copies.filter((copy) => {
    return (!filter || `${copy.card_name} ${copy.set_id} ${copy.collector_number ?? ""}`.toLowerCase().includes(filter.toLowerCase()))
      && (!ownerFilter || copy.owner_id === ownerFilter)
      && (!holderFilter || copy.holder_id === holderFilter)
      && (!availabilityFilter || (availabilityFilter === "available" ? !copy.deck_id : Boolean(copy.deck_id)))
      && (!deckFilter || copy.deck_id === deckFilter);
  }), [copies, filter, ownerFilter, holderFilter, availabilityFilter, deckFilter]);
  const activeDecks = decks.filter((deck) => deck.status === "active");
  const currentUserId = session?.user.id ?? "";

  if (!hasSupabaseConfig) return <ConfigScreen />;
  if (!authReady) return <div className="center-state"><span className="spinner" />Checking your session…</div>;
  if (!session) return <AuthScreen error={error} setError={setError} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand"><span className="brand-mark">R</span><span>RIFTBOUND<span className="brand-sub">SHARED POOL</span></span></Link>
        <div className="top-actions">
          {pools.length > 0 && <label className="pool-select"><span className="sr-only">Select pool</span><select value={pool?.id ?? ""} onChange={(e) => setPool(pools.find((p) => p.id === e.target.value) ?? null)}>{pools.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select><ChevronDown size={14} /></label>}
          <span className="user-chip">{session.user.email}</span>
          <button className="icon-button" title="Sign out" onClick={() => void supabase?.auth.signOut()}><LogOut size={17} /></button>
        </div>
      </header>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="side-label">WORKSPACE</div>
          <button className={tab === "inventory" ? "nav-item active" : "nav-item"} onClick={() => setTab("inventory")}><Boxes size={17} />Inventory<span className="nav-count">{copies.length}</span></button>
          <button className={tab === "decks" ? "nav-item active" : "nav-item"} onClick={() => setTab("decks")}><LayoutDashboard size={17} />Decks</button>
          <button className={tab === "loans" ? "nav-item active" : "nav-item"} onClick={() => setTab("loans")}><ArrowRightLeft size={17} />Loans</button>
          <button className={tab === "activity" ? "nav-item active" : "nav-item"} onClick={() => setTab("activity")}><Clock3 size={17} />Activity</button>
          <div className="side-label side-label-spaced">POOL</div>
          <button className={tab === "members" ? "nav-item active" : "nav-item"} onClick={() => setTab("members")}><Users size={17} />Members<span className="nav-count">{members.length}</span></button>
          <div className="sidebar-bottom"><Shield size={15} /><span>{pool?.role === "admin" ? "Pool administrator" : "Pool member"}</span></div>
        </aside>

        <main className="main-content">
          {error && <div className="alert error"><CircleAlert size={18} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={16} /></button></div>}
          {busy && <div className="busy-line"><span className="spinner small" /> Syncing with Supabase</div>}
          {!pool ? <EmptyPools
            pools={pools} newPoolName={newPoolName} setNewPoolName={setNewPoolName}
            onCreate={() => void withBusy(async () => {
              if (!supabase) return;
              const { data, error: e } = await supabase.rpc("create_pool", { p_name: newPoolName.trim() });
              if (e) throw e;
              setNewPoolName("");
              await loadPools();
              const created = (data as string);
              const { data: row } = await supabase.from("pools").select("id,name").eq("id", created).single();
              if (row) setPool({ ...row, role: "admin" });
            })}
            onJoin={() => void withBusy(async () => { await rpc("accept_pool_invitation", { p_invitation_id: inviteId }); setInviteId(""); await loadPools(); })}
            inviteId={inviteId} setInviteId={setInviteId}
          /> : (
            <>
              {tab === "inventory" && <section>
                <PageHeader kicker="POOL INVENTORY" title="Every copy, accounted for" text="Ownership, physical possession, and deck allocation are tracked independently." />
                <div className="stat-grid">
                  <Stat label="TOTAL COPIES" value={copies.length} />
                  <Stat label="UNALLOCATED" value={copies.filter((copy) => !copy.deck_id).length} />
                  <Stat label="IN DECKS" value={copies.filter((copy) => !!copy.deck_id).length} />
                  <Stat label="MEMBERS" value={members.length} />
                </div>
                <div className="panel add-panel">
                  <div className="panel-heading"><div><span className="eyebrow">ADD TO POOL</span><h2>Register cards</h2></div><span className="icon-badge"><Plus size={18} /></span></div>
                  <label className="search-box"><Search size={17} /><input value={cardSearch} onChange={(e) => { setCardSearch(e.target.value); setSelectedCard(null); }} placeholder="Search card name in Riftcodex…" /><kbd>↵</kbd></label>
                  {cardResults.length > 0 && !selectedCard && <div className="card-results">{cardResults.slice(0, 7).map((card) => <button key={card.id} onClick={() => { setSelectedCard(card); setCardSearch(card.name); setCardResults([]); }}><span>{card.name}</span><small>{card.set?.label ?? card.set?.set_id} · {card.classification?.rarity}</small></button>)}</div>}
                  {selectedCard && <div className="register-row">
                    {selectedCard.media?.image_url && <img src={selectedCard.media.image_url} alt="" />}
                    <div className="selected-info"><strong>{selectedCard.name}</strong><span>{selectedCard.set?.label ?? selectedCard.set?.set_id} · {selectedCard.classification?.rarity} · {selectedCard.classification?.type}</span><span>{selectedCard.classification?.domain?.join(" / ") || "No domain"}{selectedCard.attributes?.energy != null ? ` · Energy ${selectedCard.attributes.energy}` : ""}{selectedCard.attributes?.might != null ? ` · Might ${selectedCard.attributes.might}` : ""}{selectedCard.attributes?.power != null ? ` · Power ${selectedCard.attributes.power}` : ""}</span>{selectedCard.text?.plain && <span className="card-rules-text">{selectedCard.text.plain}</span>}</div>
                    <label className="qty-input"><span>Copies</span><input type="number" min="1" max="200" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} /></label>
                    <button className="button primary" disabled={busy} onClick={() => void withBusy(async () => {
                      await rpc("add_card_copies", { p_pool_id: pool.id, p_card: toCardSnapshot(selectedCard), p_quantity: quantity });
                      setSelectedCard(null); setCardSearch(""); setQuantity(1); await refresh();
                    })}>Add copies</button>
                  </div>}
                  {!selectedCard && cardSearch.length >= 2 && cardSearchLoading && <p className="muted small-copy">Searching Riftcodex…</p>}
                  {!selectedCard && cardSearch.length >= 2 && !cardSearchLoading && cardResults.length === 0 && <p className="muted small-copy">No cards found. If card search is unavailable, deploy the documented external proxy (see README).</p>}
                </div>
                <div className="section-title"><div><h2>Registered copies</h2><span>{filteredCopies.length} physical {filteredCopies.length === 1 ? "copy" : "copies"}</span></div></div>
                <div className="filter-bar">
                  <label className="filter-search"><Search size={15} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter cards…" /></label>
                  <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}><option value="">All owners</option>{members.map((m) => <option value={m.user_id} key={m.user_id}>{m.display_name}</option>)}</select>
                  <select value={holderFilter} onChange={(e) => setHolderFilter(e.target.value)}><option value="">All holders</option>{members.map((m) => <option value={m.user_id} key={m.user_id}>{m.display_name}</option>)}</select>
                  <select value={availabilityFilter} onChange={(e) => setAvailabilityFilter(e.target.value)}><option value="">Any allocation</option><option value="available">Unallocated</option><option value="allocated">In deck</option></select>
                  <select value={deckFilter} onChange={(e) => setDeckFilter(e.target.value)}><option value="">All decks</option>{decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
                </div>
                {filteredCopies.length === 0 ? <div className="empty-state"><Boxes size={27} /><strong>No copies match</strong><span>Add cards above or adjust your filters.</span></div> : <div className="inventory-list">{filteredCopies.map((copy) => <CopyCard key={copy.id} copy={copy} owner={memberName(copy.owner_id)} holder={memberName(copy.holder_id)} deck={deckName(copy.deck_id)} members={members} decks={activeDecks} currentUserId={currentUserId} onTransfer={(newOwner) => void withBusy(async () => { await rpc("transfer_copy_ownership", { p_copy_id: copy.id, p_new_owner_id: newOwner }); await refresh(); })} onRequestLoan={(userId) => void withBusy(async () => { await rpc("request_loan_handover", { p_copy_id: copy.id, p_to_holder: userId }); await refresh(); })} onAllocate={(deckId) => void withBusy(async () => { await rpc("allocate_copy", { p_copy_id: copy.id, p_deck_id: deckId }); await refresh(); })} onDeallocate={() => void withBusy(async () => { await rpc("deallocate_copy", { p_copy_id: copy.id }); await refresh(); })} />)}</div>}
              </section>}
              {tab === "decks" && <section>
                <PageHeader kicker="DECK WORKSPACE" title="Plan with the pool" text="Requests describe what a deck needs; allocations reserve specific physical copies. No format rules are assumed." />
                <div className="panel new-deck-row"><input value={newDeckName} onChange={(e) => setNewDeckName(e.target.value)} placeholder="Name your deck" /><button className="button primary" disabled={!newDeckName.trim() || busy} onClick={() => void withBusy(async () => { await rpc("create_deck", { p_pool_id: pool.id, p_name: newDeckName.trim() }); setNewDeckName(""); await refresh(); })}><Plus size={16} /> Create deck</button></div>
                {activeDecks.map((deck) => <DeckPanel key={deck.id} deck={deck} requests={requests.filter((r) => r.deck_id === deck.id)} copies={copies} onRequest={(card) => withBusy(async () => { if (!supabase) return; const snap = toCardSnapshot(card); const existing = requests.find((r) => r.deck_id === deck.id && r.card_id === snap.card_id); const { error: e } = await supabase.from("deck_requests").upsert({ pool_id: pool.id, deck_id: deck.id, card_id: snap.card_id, card_name: snap.name, quantity: Math.min(200, (existing?.quantity ?? 0) + 1) }, { onConflict: "deck_id,card_id" }); if (e) throw e; await refresh(); })} onQuantityChange={(request, quantity) => withBusy(async () => { if (!supabase || quantity < 1 || quantity > 200) return; const { error: e } = await supabase.from("deck_requests").update({ quantity }).eq("id", request.id); if (e) throw e; await refresh(); })} cardSearch={cardSearch} setCardSearch={setCardSearch} results={cardResults} cardSearchLoading={cardSearchLoading} searchTarget={requestSearchDeck} setSearchTarget={setRequestSearchDeck} onArchive={() => void withBusy(async () => { if (!supabase) return; const { error: e } = await supabase.from("decks").update({ status: "archived" }).eq("id", deck.id); if (e) throw e; await refresh(); })} />)}
                {decks.some((d) => d.status === "archived") && <div className="archived-note">{decks.filter((d) => d.status === "archived").length} archived deck(s) are retained in pool history.</div>}
                <AllocationPanel poolId={pool.id} decks={activeDecks} requests={requests} copies={copies.filter((c) => !c.deck_id)} onAllocate={(deckId, copyId) => withBusy(async () => { await rpc("allocate_copy", { p_copy_id: copyId, p_deck_id: deckId }); await refresh(); })} allocation={allocation} setAllocation={setAllocation} />
              </section>}
              {tab === "loans" && <section><PageHeader kicker="PHYSICAL POSSESSION" title="Loan handovers" text="A request does not move a card. The receiving member confirms each handover; the owner confirms each return." />
                {loans.length === 0 ? <EmptyNotice icon={<ArrowRightLeft size={25} />} title="No handovers yet" detail="Loan requests and their confirmed returns will appear here." /> : <div className="panel table-panel"><table><thead><tr><th>CARD</th><th>FROM</th><th>TO</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{loans.map((loan) => <tr key={loan.id}><td>{loan.card_name ?? "Physical copy"}</td><td>{memberName(loan.status === "return_pending" ? loan.return_from ?? loan.from_holder : loan.from_holder)}</td><td>{memberName(loan.status === "return_pending" ? loan.return_to ?? loan.to_holder : loan.to_holder)}</td><td><Status value={loan.status} /></td><td>{loan.status === "pending" && loan.to_holder === currentUserId ? <button className="text-action" onClick={() => void withBusy(async () => { await rpc("confirm_loan_handover", { p_loan_id: loan.id }); await refresh(); })}>Confirm handover</button> : loan.status === "accepted" && loan.to_holder === currentUserId ? <button className="text-action" onClick={() => void withBusy(async () => { await rpc("request_loan_return", { p_loan_id: loan.id }); await refresh(); })}>Request return</button> : loan.status === "return_pending" && loan.return_to === currentUserId ? <button className="text-action" onClick={() => void withBusy(async () => { await rpc("confirm_loan_return", { p_loan_id: loan.id }); await refresh(); })}>Confirm return</button> : "—"}</td></tr>)}</tbody></table></div>}
              </section>}
              {tab === "members" && <section><PageHeader kicker="POOL ACCESS" title="Members & invitations" text="The pool owner controls membership. Roles are enforced by database policies, not just the interface." />
                <div className="panel member-list">{members.map((member) => <div className="member-row" key={member.user_id}><div className="avatar">{member.display_name.slice(0, 1).toUpperCase()}</div><div className="member-copy"><strong>{member.display_name}</strong><span>{member.email || member.user_id}</span></div><span className={member.role === "admin" ? "role-pill admin" : "role-pill"}>{member.role}</span></div>)}</div>
                {pool.role === "admin" && <div className="panel invite-panel"><span className="eyebrow">ADMIN ACTION</span><h2>Invite a member</h2><p>Generate an invitation for an email address. Share its ID with the invitee; they can accept it after creating an account.</p><form className="invite-form" onSubmit={(e) => { e.preventDefault(); void withBusy(async () => { if (!supabase) return; const { data, error: e2 } = await supabase.from("pool_invitations").insert({ pool_id: pool.id, email: inviteEmail.trim().toLowerCase(), role: "member" }).select("id").single(); if (e2) throw e2; setInviteId(data.id); setInviteEmail(""); }); }}><input type="email" required value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="person@example.com" /><button className="button primary" disabled={busy}><Plus size={16} /> Create invite</button></form>{inviteId && <div className="invite-code"><span>Invitation ID</span><code>{inviteId}</code><button className="icon-button" title="Copy invitation ID" onClick={() => void navigator.clipboard.writeText(inviteId)}><Copy size={16} /></button></div>}</div>}
                <div className="panel join-panel"><div><span className="eyebrow">HAVE AN INVITATION?</span><h2>Join a shared pool</h2></div><form onSubmit={(e) => { e.preventDefault(); void withBusy(async () => { await rpc("accept_pool_invitation", { p_invitation_id: inviteId }); setInviteId(""); await loadPools(); }); }}><input value={inviteId} onChange={(e) => setInviteId(e.target.value)} placeholder="Paste invitation ID" required /><button className="button secondary" disabled={busy}>Accept invite <ArrowRightLeft size={15} /></button></form></div>
              </section>}
              {tab === "activity" && <section><PageHeader kicker="AUDIT TRAIL" title="Pool activity" text="Ownership, holder changes, deck reservations, and invitation activity are recorded with the acting member." />
                {audit.length === 0 ? <EmptyNotice icon={<Clock3 size={25} />} title="Nothing in the activity log yet" detail="Copy registration and subsequent actions will show up here." /> : <div className="panel activity-list">{audit.map((item) => <div className="activity-row" key={item.id}><span className="activity-dot" /><div><strong>{activityLabel(item.event_type)}</strong><span>{item.details?.card_name ?? item.copy_id.slice(0, 8)} · {new Date(item.created_at).toLocaleString()}</span></div><code>{item.event_type.replaceAll("_", " ")}</code></div>)}</div>}
              </section>}
            </>
          )}
        </main>
      </div>
      <footer className="footer"><span>RIFTBOUND POOL · SHARED INVENTORY</span><span>Powered by Supabase · Cards by <a href="https://riftcodex.com/" target="_blank" rel="noreferrer">Riftcodex</a></span></footer>
    </div>
  );
}

function ConfigScreen() {
  return <div className="center-state"><div className="auth-card"><span className="brand-mark">R</span><h1>Connect your Supabase project</h1><p>Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to your local <code>.env</code> and configure them in GitHub Actions secrets.</p></div></div>;
}

function AuthScreen({ error, setError }: { error: string; setError: (s: string) => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) return;
    setError(""); setNotice(""); setLoading(true);
    try {
      if (mode === "signup") {
        const { error: e } = await supabase.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: window.location.href } });
        if (e) throw e;
        setNotice("Check your email to confirm the account, then sign in.");
      } else {
        const { error: e } = await supabase.auth.signInWithPassword({ email, password });
        if (e) throw e;
      }
    } catch (e) { setError(message(e)); } finally { setLoading(false); }
  };
  return <div className="auth-layout"><div className="auth-art"><div className="art-orb orb-one" /><div className="art-orb orb-two" /><span className="eyebrow">THE CARD POOL, IN SYNC</span><h1>Every card has<br /><em>a place.</em></h1><p>Know what you own, where it is, and which deck needs it — together.</p><div className="auth-art-bottom"><span>SHARED COLLECTION MANAGEMENT</span><span>01 / 01</span></div></div><div className="auth-form-wrap"><div className="auth-card"><Link to="/" className="brand"><span className="brand-mark">R</span><span>RIFTBOUND<span className="brand-sub">SHARED POOL</span></span></Link><span className="eyebrow auth-eyebrow">{mode === "signin" ? "WELCOME BACK" : "START A SHARED POOL"}</span><h2>{mode === "signin" ? "Sign in to your pool" : "Create your account"}</h2><p className="muted">Your collection stays shared across all your devices.</p>{error && <div className="alert error"><CircleAlert size={17} />{error}</div>}{notice && <div className="alert success"><Check size={17} />{notice}</div>}<form onSubmit={(e) => void submit(e)}>{mode === "signup" && <label>Your name<input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}<label>Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label><label>Password<input required type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} /></label><button className="button primary full" disabled={loading}>{loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}<ArrowRightLeft size={16} /></button></form><div className="auth-switch">{mode === "signin" ? "New to the pool?" : "Already have an account?"}<button onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); }}>{mode === "signin" ? "Create account" : "Sign in"}</button></div></div></div></div>;
}

function EmptyPools({ pools, newPoolName, setNewPoolName, onCreate, onJoin, inviteId, setInviteId }: { pools: Pool[]; newPoolName: string; setNewPoolName: (s: string) => void; onCreate: () => void; onJoin: () => void; inviteId: string; setInviteId: (s: string) => void }) {
  return <div className="welcome-panel"><div className="welcome-icon"><Boxes size={27} /></div><span className="eyebrow">YOUR SHARED WORKSPACE</span><h1>{pools.length ? "Choose a pool" : "Start a pool together"}</h1><p>Create a shared collection or accept an invitation to join someone else's.</p><div className="welcome-actions"><form onSubmit={(e) => { e.preventDefault(); onCreate(); }}><input value={newPoolName} onChange={(e) => setNewPoolName(e.target.value)} placeholder="New pool name" required /><button className="button primary"><Plus size={16} /> Create pool</button></form><div className="divider"><span>OR</span></div><form onSubmit={(e) => { e.preventDefault(); onJoin(); }}><input value={inviteId} onChange={(e) => setInviteId(e.target.value)} placeholder="Invitation ID" required /><button className="button secondary">Join pool <ArrowRightLeft size={15} /></button></form></div><small>Member access is verified by Supabase on every database request.</small></div>;
}

function PageHeader({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return <div className="page-header"><span className="eyebrow">{kicker}</span><h1>{title}</h1><p>{text}</p></div>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="stat-card"><span>{label}</span><strong>{value.toLocaleString()}</strong></div>;
}

function CopyCard({ copy, owner, holder, deck, members, decks, currentUserId, onTransfer, onRequestLoan, onAllocate, onDeallocate }: { copy: CopyRow; owner: string; holder: string; deck: string; members: Member[]; decks: Deck[]; currentUserId: string; onTransfer: (id: string) => void; onRequestLoan: (id: string) => void; onAllocate: (id: string) => void; onDeallocate: () => void }) {
  const [open, setOpen] = useState(false);
  return <article className="copy-row">
    {copy.image_url ? <img className="card-thumb" src={copy.image_url} alt="" loading="lazy" /> : <div className="card-thumb placeholder-card"><Boxes size={22} /></div>}
    <div className="copy-main"><strong>{copy.card_name}</strong><span>{copy.set_id || "Unknown set"}{copy.collector_number ? ` · #${copy.collector_number}` : ""}{copy.rarity ? ` · ${copy.rarity}` : ""}</span><div className="copy-tags"><span className="ownership-tag">Owned by {owner}</span><span className={copy.holder_id === copy.owner_id ? "holder-tag" : "holder-tag borrowed"}>{copy.holder_id === copy.owner_id ? "With owner" : `Held by ${holder}`}</span><Status value={copy.deck_id ? "allocated" : "available"} /></div></div>
    <div className="copy-deck">{copy.deck_id ? <><span>ALLOCATED TO</span><strong>{deck}</strong></> : <><span>DECK STATUS</span><strong className="green-text">Available</strong></>}</div>
    <button className="icon-button copy-menu" onClick={() => setOpen(!open)} aria-label="Copy actions"><Settings size={17} /></button>
    {open && <div className="copy-actions">
      <label>Transfer ownership<select value="" onChange={(e) => { if (e.target.value) onTransfer(e.target.value); setOpen(false); }}><option value="">Choose new owner…</option>{members.filter((m) => m.user_id !== copy.owner_id).map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</select></label>
      {copy.holder_id === currentUserId && <label>Request loan handover<select value="" onChange={(e) => { if (e.target.value) onRequestLoan(e.target.value); setOpen(false); }}><option value="">Choose recipient…</option>{members.filter((m) => m.user_id !== currentUserId).map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</select></label>}
      {!copy.deck_id && <label>Allocate to deck<select value="" onChange={(e) => { if (e.target.value) onAllocate(e.target.value); setOpen(false); }}><option value="">Choose deck…</option>{decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
      {!!copy.deck_id && <button className="plain-action" onClick={() => { onDeallocate(); setOpen(false); }}>Remove from deck</button>}
    </div>}
  </article>;
}

function DeckPanel({ deck, requests, copies, onRequest, onQuantityChange, cardSearch, setCardSearch, results, cardSearchLoading, searchTarget, setSearchTarget, onArchive }: { deck: Deck; requests: RequestRow[]; copies: CopyRow[]; onRequest: (card: RiftCard) => Promise<void>; onQuantityChange: (request: RequestRow, quantity: number) => Promise<void>; cardSearch: string; setCardSearch: (value: string) => void; results: RiftCard[]; cardSearchLoading: boolean; searchTarget: string; setSearchTarget: (deckId: string) => void; onArchive: () => void }) {
  const deckCopies = copies.filter((copy) => copy.deck_id === deck.id);
  return <div className="panel deck-panel"><div className="deck-heading"><div><span className="eyebrow">ACTIVE DECK</span><h2>{deck.name}</h2><span>{requests.length} requested card types · {deckCopies.length} copies allocated</span></div><button className="text-action muted-action" onClick={onArchive}>Archive deck</button></div>
    <div className="deck-search"><label className="search-box"><Search size={16} /><input value={cardSearch} onFocus={() => setSearchTarget(deck.id)} onChange={(e) => { setSearchTarget(deck.id); setCardSearch(e.target.value); }} placeholder="Find a card to request…" /></label>{searchTarget === deck.id && results.slice(0, 5).map((card) => <button key={card.id} className="deck-result" onClick={() => { void onRequest(card); setCardSearch(""); }}>{card.name}<span>{card.set?.set_id}</span><Plus size={14} /></button>)}{searchTarget === deck.id && cardSearch.length >= 2 && results.length === 0 && <div className="deck-search-state">{cardSearchLoading ? "Searching Riftcodex…" : "No card results. Check the Riftcodex proxy setup if this persists."}</div>}</div>
    {requests.length === 0 ? <p className="muted empty-inline">No requests yet. Search a card above to add a requested quantity.</p> : <div className="request-list">{requests.map((request) => <RequestLine key={request.id} request={request} deckId={deck.id} copies={copies} onQuantityChange={onQuantityChange} />)}</div>}
  </div>;
}

function RequestLine({ request, deckId, copies, onQuantityChange }: { request: RequestRow; deckId: string; copies: CopyRow[]; onQuantityChange: (request: RequestRow, quantity: number) => Promise<void> }) {
  const [draft, setDraft] = useState(String(request.quantity));
  useEffect(() => setDraft(String(request.quantity)), [request.quantity]);
  const assigned = copies.filter((copy) => copy.deck_id === deckId && copy.card_id === request.card_id).length;
  const available = copies.filter((copy) => !copy.deck_id && copy.card_id === request.card_id).length;
  const saveQuantity = () => {
    const quantity = Number(draft);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 200) {
      setDraft(String(request.quantity));
    } else if (quantity !== request.quantity) {
      void onQuantityChange(request, quantity);
    }
  };
  return <div className="request-row"><div><strong>{request.card_name}</strong><span>{available} available in pool</span></div><span className="quantity-summary">{assigned} / {request.quantity}<small>allocated / requested</small></span><label className="request-qty">Need<input type="number" min="1" max="200" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={saveQuantity} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label><span className={available >= request.quantity - assigned ? "availability ok" : "availability missing"}>{Math.max(0, request.quantity - assigned - available)} missing</span></div>;
}

function AllocationPanel({ poolId, decks, requests, copies, onAllocate, allocation, setAllocation }: { poolId: string; decks: Deck[]; requests: RequestRow[]; copies: CopyRow[]; onAllocate: (deck: string, copy: string) => Promise<void>; allocation: { deck: string; card: string; copy: string }; setAllocation: (value: { deck: string; card: string; copy: string }) => void }) {
  const eligibleRequests = requests.filter((request) => request.deck_id === allocation.deck);
  const eligibleCopies = copies.filter((copy) => copy.pool_id === poolId && copy.card_id === allocation.card);
  return <div className="panel allocate-panel"><div><span className="eyebrow">SPECIFIC-COPY ALLOCATION</span><h2>Reserve a physical copy</h2><p>Allocation is atomic: competing reservations cannot claim the same copy or exceed the requested quantity.</p></div><div className="allocation-controls"><select value={allocation.deck} onChange={(e) => setAllocation({ deck: e.target.value, card: "", copy: "" })}><option value="">Select deck</option>{decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select><select value={allocation.card} disabled={!allocation.deck} onChange={(e) => setAllocation({ ...allocation, card: e.target.value, copy: "" })}><option value="">Select requested card</option>{eligibleRequests.map((r) => <option key={r.id} value={r.card_id}>{r.card_name}</option>)}</select><select value={allocation.copy} disabled={!allocation.card} onChange={(e) => setAllocation({ ...allocation, copy: e.target.value })}><option value="">Select available copy</option>{eligibleCopies.map((c) => <option key={c.id} value={c.id}>{c.card_name} · {c.set_id} · owned by {c.owner_id.slice(0, 8)}</option>)}</select><button className="button primary" disabled={!allocation.deck || !allocation.copy} onClick={() => { void onAllocate(allocation.deck, allocation.copy); setAllocation({ deck: "", card: "", copy: "" }); }}>Allocate copy <ArrowRightLeft size={15} /></button></div></div>;
}

function Status({ value }: { value: string }) {
  const label = value.replaceAll("_", " ");
  return <span className={`status status-${value}`}>{value === "available" || value === "accepted" ? <Check size={11} /> : value === "pending" || value === "return_pending" ? <Clock3 size={11} /> : null}{label}</span>;
}

function EmptyNotice({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="empty-state">{icon}<strong>{title}</strong><span>{detail}</span></div>;
}

function activityLabel(event: string) {
  const labels: Record<string, string> = { copy_added: "Cards registered", ownership_transferred: "Ownership transferred", holder_changed: "Physical possession changed", deck_allocated: "Copy allocated to a deck", deck_deallocated: "Copy removed from a deck", loan_handover_requested: "Loan handover requested", loan_accepted: "Loan handover confirmed", loan_return_pending: "Return confirmation requested", loan_returned: "Loan return confirmed" };
  return labels[event] ?? "Pool activity";
}
