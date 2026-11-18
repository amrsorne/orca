// @orca-isolated-worker -- Suite hooks own the temporary SQL worker bundle.
// Scratch A/B benchmark for chat-index-l2 (not committed). Same file runs on base and head.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { agentSessionProviderHandleKey, claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  storedTestAgentSessionRecord,
  withTestAgentSessionDatabase
} from './agent-session-record-store-persistence.test-fixture'
import { openTestAgentSessionDatabase, closeTestAgentSessionDatabase } from './agent-session-record-store-test-harness'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { projectStructuredAiVaultSessions } from '../../../ai-vault/structured-sessions/structured-session-ownership'
import { listStructuredProviderSessionOwnership } from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'

const SIZES = (process.env.L2_SIZES ?? '1000,9500,18000,36000').split(',').map(Number)
const WORKSPACES = 1900

function seedRow(index: number) {
  const sessionId = `chat-${String(index).padStart(6, '0')}`
  const base = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId, claimStatus: 'released', ownerProcess: null, reservedSpawnToken: null })
  )
  // Every 50th chat shares its native id with the next one (a fork/copy), to exercise tie rules.
  const nativeId = `native-${index - (index % 50 === 1 ? 1 : 0)}`
  return storedTestAgentSessionRecord({
    ...base,
    location: { ...base.location, workspaceId: `workspace-${index % WORKSPACES}` },
    // Chat 0 holds a 256-link chain (the longest a record allows).
    providerHandleChain:
      index === 0
        ? Array.from({ length: 256 }, (_, k) =>
            k === 0
              ? { ...base.providerHandleChain[0]!, handle: claudeProviderHandle('long-0', null) }
              : {
                  linkId: `long-link-${k}`,
                  origin: 'forked' as const,
                  forkedFromKey: agentSessionProviderHandleKey(claudeProviderHandle(`long-${k - 1}`, null)),
                  mintedAtFence: base.providerHandleChain[0]!.mintedAtFence,
                  observedAt: 2_000 + k,
                  handle: claudeProviderHandle(`long-${k}`, null)
                }
          )
        : base.providerHandleChain.map((link) => ({
            ...link,
            handle: claudeProviderHandle(nativeId, null)
          })),
    conversationName: `Chat ${index} about a reasonably long topic name`
  })
}

const median = (xs: number[]) => +[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!.toFixed(3)
function time(runs: number, fn: () => unknown): number {
  fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    fn()
    samples.push(performance.now() - t)
  }
  return median(samples)
}
async function timeAsync(runs: number, fn: () => Promise<unknown>): Promise<number> {
  await fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    await fn()
    samples.push(performance.now() - t)
  }
  return median(samples)
}

it('chat-index-l2 ab', { timeout: 1_800_000 }, async () => {
  const results: unknown[] = []
  for (const total of SIZES) {
    const root = await mkdtemp(join(tmpdir(), 'l2-ab-'))
    const journalDatabase = await openTestAgentSessionDatabase(root)
    await withTestAgentSessionDatabase(root, (db) => {
      const insert = db.prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)')
      db.exec('BEGIN')
      for (let i = 0; i < total; i++) {
        const row = seedRow(i)
        insert.run(row.sessionId, JSON.stringify(row))
      }
      db.exec('COMMIT')
    })
    const store = AgentSessionRecordStore.open({
      journalDatabase,
      records: await journalDatabase.loadRecords(),
      hostId: 'local',
      legacySessionTabIds: []
    })
    setStructuredAgentSessionHost({ deps: { store } } as never)
    // A history page of 50 rows spread over the store, plus 5 unowned rows.
    const page = (offset: number) => ({
      sessions: [
        ...Array.from({ length: 50 }, (_, k) => ({
          agent: 'claude',
          sessionId: `native-${Math.floor(((k + offset) * total) / 53) % total}`,
          executionHostId: 'local'
        })),
        ...Array.from({ length: 5 }, (_, k) => ({ agent: 'claude', sessionId: `unowned-${k}`, executionHostId: 'local' }))
      ]
    })
    const project = (offset: number) =>
      projectStructuredAiVaultSessions(page(offset) as never, () => true) as unknown as {
        sessions: { sessionId: string; structuredSession?: { sessionId: string } }[]
      }
    // Reference: the full-scan pick (first head link, else first link, in listing order).
    const reference = () => {
      const byId = new Map<string, { sessionId: string; role: string }>()
      for (const o of listStructuredProviderSessionOwnership(store.listConversations())) {
        const kept = byId.get(o.providerSessionId)
        if (!kept || (kept.role !== 'head' && o.role === 'head')) byId.set(o.providerSessionId, o)
      }
      return byId
    }
    const check = (offset: number) => {
      const ref = reference()
      for (const row of project(offset).sessions) {
        expect(row.structuredSession?.sessionId ?? null).toBe(ref.get(row.sessionId)?.sessionId ?? null)
      }
    }
    check(0)
    const aiVaultPageMs = time(20, () => project(1))
    const longPage = {
      sessions: Array.from({ length: 256 }, (_, k) => ({ agent: 'claude', sessionId: `long-${k}`, executionHostId: 'local' }))
    }
    expect(store.getConversation('chat-000000')?.providerHandleChain.length).toBe(256)
    const longChainPageMs = time(20, () => projectStructuredAiVaultSessions(longPage as never, () => true))
    const location = store.listConversations()[7]!.location
    const workspaceAttentionMs = await timeAsync(10, () => store.workspaceAttentionReads(location))
    const attention = await store.workspaceAttentionReads(location)
    // Per-commit upkeep: renames with the indexes built (head) / nothing to maintain (base).
    let n = 0
    const commitMs = await timeAsync(20, () => store.setConversationName(`chat-${String(n++ % total).padStart(6, '0')}`, `Renamed ${n}`))
    check(2)
    results.push({ total, aiVaultPageMs, longChainPageMs, workspaceAttentionMs, workspaceChats: attention.length, commitMs })
    await closeTestAgentSessionDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
  console.log('L2-AB ' + JSON.stringify(results))
})
