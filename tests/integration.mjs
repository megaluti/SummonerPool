import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  throw new Error("Set SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY for integration tests.");
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const createdUsers = [];
let poolId;
const clients = [];

async function createTestUser(label) {
  const email = `riftbound-test-${randomUUID()}@example.com`;
  const password = `T-${randomUUID()}aA1!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: label },
  });
  if (error) throw error;
  createdUsers.push(data.user.id);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  clients.push(client);
  return { id: data.user.id, email, password, client };
}

async function signInOnAnotherDevice(user) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw error;
  clients.push(client);
  return client;
}

function checked(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function invite(adminClient, pool, email) {
  const invitation = checked(await adminClient.from("pool_invitations")
    .insert({ pool_id: pool, email, role: "member" }).select("id").single(), "Create invitation");
  return invitation.id;
}

async function run() {
  const [owner, member, borrower, outsider] = await Promise.all([
    createTestUser("Pool owner"),
    createTestUser("Second member"),
    createTestUser("Third member"),
    createTestUser("Unaffiliated user"),
  ]);
  const secondDevice = await signInOnAnotherDevice(owner);
  const ownerClient = owner.client;
  const memberClient = member.client;
  const borrowerClient = borrower.client;
  const { data: pool, error: poolError } = await ownerClient.rpc("create_pool", { p_name: "Integration test pool" });
  if (poolError) throw poolError;
  poolId = pool;
  for (const user of [member, borrower]) {
    const invitationId = await invite(ownerClient, poolId, user.email);
    checked(await user.client.rpc("accept_pool_invitation", { p_invitation_id: invitationId }), "Accept invitation");
  }

  checked(await ownerClient.rpc("add_card_copies", {
    p_pool_id: poolId,
    p_card: { card_id: "integration-card-1", name: "Integration Test Card", set_id: "TST", image_url: "", rarity: "Test" },
    p_quantity: 4,
  }), "Register copies");
  const allCopies = checked(await ownerClient.from("copies").select("id,card_id,owner_id,holder_id,deck_id").eq("pool_id", poolId), "Read registered copies");
  assert.equal(allCopies.length, 4, "Bulk entry should create four distinct physical copies.");

  const { data: secondDeviceRows, error: secondDeviceError } = await secondDevice.from("copies")
    .select("id").eq("pool_id", poolId);
  if (secondDeviceError) throw secondDeviceError;
  assert.equal(secondDeviceRows.length, 4, "A separate signed-in client sees persisted pool inventory.");

  const decks = [];
  for (const name of ["Race deck A", "Race deck B", "Quantity cap deck"]) {
    const { data: deckId, error } = await ownerClient.rpc("create_deck", { p_pool_id: poolId, p_name: name });
    if (error) throw error;
    decks.push(deckId);
    checked(await ownerClient.from("deck_requests").insert({
      pool_id: poolId, deck_id: deckId, card_id: "integration-card-1", card_name: "Integration Test Card", quantity: 1,
    }), "Create deck request");
  }

  const sameCopyRace = await Promise.all([
    ownerClient.rpc("allocate_copy", { p_copy_id: allCopies[0].id, p_deck_id: decks[0] }),
    secondDevice.rpc("allocate_copy", { p_copy_id: allCopies[0].id, p_deck_id: decks[1] }),
  ]);
  assert.equal(sameCopyRace.filter((result) => !result.error).length, 1, "Only one concurrent deck can reserve a physical copy.");

  const quantityRace = await Promise.all([
    ownerClient.rpc("allocate_copy", { p_copy_id: allCopies[1].id, p_deck_id: decks[2] }),
    secondDevice.rpc("allocate_copy", { p_copy_id: allCopies[2].id, p_deck_id: decks[2] }),
  ]);
  assert.equal(quantityRace.filter((result) => !result.error).length, 1, "Concurrent allocations cannot exceed a card's requested quantity.");
  const cappedCopies = checked(await ownerClient.from("copies").select("id").eq("deck_id", decks[2]), "Verify quantity cap");
  assert.equal(cappedCopies.length, 1);

  const { data: unauthorizedRows, error: unauthorizedError } = await outsider.client.from("copies")
    .select("id").eq("pool_id", poolId);
  if (unauthorizedError) throw unauthorizedError;
  assert.equal(unauthorizedRows.length, 0, "RLS must hide pool copies from a non-member.");
  const unauthorizedTransfer = await outsider.client.rpc("transfer_copy_ownership", {
    p_copy_id: allCopies[3].id, p_new_owner_id: outsider.id,
  });
  assert.ok(unauthorizedTransfer.error, "A non-member cannot call pool mutation RPCs.");

  const independentCopyId = allCopies[3].id;
  const { error: handoverError } = await ownerClient.rpc("request_loan_handover", {
    p_copy_id: independentCopyId, p_to_holder: borrower.id,
  });
  if (handoverError) throw handoverError;
  const { data: loan, error: loanError } = await ownerClient.from("loan_requests")
    .select("id").eq("copy_id", independentCopyId).eq("status", "pending").single();
  if (loanError) throw loanError;
  checked(await borrowerClient.rpc("confirm_loan_handover", { p_loan_id: loan.id }), "Confirm handover");
  let independent = checked(await ownerClient.from("copies").select("owner_id,holder_id").eq("id", independentCopyId).single(), "Check independent possession");
  assert.equal(independent.owner_id, owner.id, "Handover must not change ownership.");
  assert.equal(independent.holder_id, borrower.id);
  checked(await ownerClient.rpc("transfer_copy_ownership", {
    p_copy_id: independentCopyId, p_new_owner_id: member.id,
  }), "Transfer ownership while the copy is loaned");
  independent = checked(await ownerClient.from("copies").select("owner_id,holder_id").eq("id", independentCopyId).single(), "Check independent ownership");
  assert.equal(independent.owner_id, member.id);
  assert.equal(independent.holder_id, borrower.id, "Ownership transfer must not change the current physical holder.");
  checked(await borrowerClient.rpc("request_loan_return", { p_loan_id: loan.id }), "Request return");
  checked(await memberClient.rpc("confirm_loan_return", { p_loan_id: loan.id }), "Confirm return");
  independent = checked(await ownerClient.from("copies").select("owner_id,holder_id").eq("id", independentCopyId).single(), "Check returned copy");
  assert.equal(independent.owner_id, member.id);
  assert.equal(independent.holder_id, member.id);

  console.log("Integration checks passed: persistence, RLS, allocation races, ownership/possession independence, confirmed loan return.");
}

try {
  await run();
} finally {
  if (poolId) {
    const { error } = await admin.from("pools").delete().eq("id", poolId);
    if (error) console.error("Test pool cleanup failed:", error.message);
  }
  for (const id of createdUsers) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.error(`Test user cleanup failed (${id}):`, error.message);
  }
  for (const client of clients) await client.auth.signOut();
}
