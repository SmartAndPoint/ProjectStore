// The band above the prompt, through the host's own test kit
// (`claude plugin test`): the module loaded as Claude Code loads it, drawn on
// the terminal and on Desktop. The rules it draws by are tested in node too
// (tests/band-model.test.mjs); these tests are the module's plumbing.
//
// Spec: the band above the prompt — rows, heartbeat, command and the status
// line's yield (contract numbers in each test's name).

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BINDING_PATH, SESSIONS, VAULT, band, binding, pointer, spawn, world } from './world'

type W = ReturnType<typeof world>

// The turn events the band hooks, raised as the engine raises them; the
// kit's typed `$` names only the calls a plugin may make itself.
const turn = ($: Engine) => ($ as unknown as { turn: { complete: (e: unknown) => Promise<unknown>; step: (e: unknown) => AsyncIterable<unknown> } }).turn

async function start($: Engine, w: W) {
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: true })
  await w.clock.settle()
}

const mount = ($: Engine, surface: 'terminal' | 'desktop', maxRows = 20, bodyColumns = 120, hasSurvey = false) =>
  $.ui.mount({ plugin: 'projectstore', surface, component: 'AbovePrompt', props: band(maxRows, bodyColumns, hasSurvey) })

const hostBand = (on: Parameters<typeof world>[0]) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>the host's own band</Text>
  })

test("contract 2, 4–8: this session's epic — head with badge, goal, stages, story", async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  await start($, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: /\[PS#9\.9\.9\] 📚 PS-HARNESS Harness adapters · this session/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /goal\s+Ship ProjectStore as one repository, one version\.$/ })).toBeDefined()
    // superseded and no-status stories count nowhere: 1 done, 2 in work, 1 backlog.
    expect(await ui.find({ type: 'Text', text: /25%\s+1 done · 2 in work · 1 backlog · 4 stories/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /story A story · in progress/ })).toBeDefined()
    await ui.unmount()
  }
})

test('contract 2: switched off draws nothing, and the next tick stops the heartbeat', async ($, on) => {
  hostBand(on)
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  await start($, w)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚 PS-HARNESS/ })).toBeDefined()
  await w.clock.advance(6_000)
  expect(JSON.parse(w.writes.get(`${SESSIONS}/.band-s1.json`) ?? '{}').drawn).toBe(true)

  w.put(BINDING_PATH, binding({ band: { enabled: false } }))
  await w.clock.advance(6_000)
  expect(await ui.find({ type: 'Text', text: /📚/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /the host's own band/ })).toBeDefined()
  await w.clock.advance(6_000)
  expect(JSON.parse(w.writes.get(`${SESSIONS}/.band-s1.json`) ?? '{}').drawn).toBe(false)
  await ui.unmount()
})

test('contract 2: a pin fills a session with no epic, never one with its own', async ($, on) => {
  hostBand(on)
  const w = world(on, { [BINDING_PATH]: binding({ band: { epic: 'PS-WT' } }) })
  await start($, w)
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚 PS-WT Parallel sessions · pinned/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s+story\s/ })).toBeUndefined()
  await ui.unmount()

  w.put(`${SESSIONS}/s1.json`, pointer('PS-HARNESS'))
  await w.clock.advance(6_000)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚 PS-HARNESS .* · this session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PS-WT/ })).toBeUndefined()
  await ui.unmount()
})

test('contract 2: no epic of its own and no pin — the host draws its own band', async ($, on) => {
  hostBand(on)
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/other.json`]: pointer('PS-HARNESS') })
  await start($, w)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /the host's own band/ })).toBeDefined()
  await ui.unmount()
})

test('contract 3: rows by priority within maxRows; a row without content frees its slot; nothing during a question', async ($, on) => {
  hostBand(on)
  const w = world(on, {
    [BINDING_PATH]: binding(),
    [`${SESSIONS}/s1.json`]: pointer('PS-NOGOAL'),
    [`${VAULT}/epics/PS-NOGOAL/epic.md`]: '---\ntype: epic\ntitle: "No goal here"\n---\n\n## Stories\n',
    [`${VAULT}/epics/PS-NOGOAL/stories/a.md`]: '---\nstatus: done\n---\n',
  })
  await start($, w)
  const rows = async (maxRows: number) => {
    const ui = await mount($, 'terminal', maxRows)
    const seen = {
      head: Boolean(await ui.find({ type: 'Text', text: /📚 PS-NOGOAL/ })),
      progress: Boolean(await ui.find({ type: 'Text', text: /100%/ })),
      goal: Boolean(await ui.find({ type: 'Text', text: /^\s+goal\s/ })),
      story: Boolean(await ui.find({ type: 'Text', text: /^\s+story\s/ })),
    }
    await ui.unmount()
    return seen
  }
  expect(await rows(1)).toEqual({ head: true, progress: false, goal: false, story: false })
  expect(await rows(2)).toEqual({ head: true, progress: true, goal: false, story: false })
  // No goal: its slot goes to the story.
  expect(await rows(3)).toEqual({ head: true, progress: true, goal: false, story: true })

  const ui = await mount($, 'terminal', 20, 120, true)
  expect(await ui.find({ type: 'Text', text: /📚/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /the host's own band/ })).toBeDefined()
  await ui.unmount()
})

test('contract 4: statusline.show_version false hides the badge', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding({ statusline: { show_version: false } }), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  await start($, w)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚 PS-HARNESS/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\[PS#/ })).toBeUndefined()
  await ui.unmount()
})

test('contracts 5, 6: the hint until the command is used; at a narrow width it goes before the counts', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  await start($, w)
  let ui = await mount($, 'terminal', 20, 140)
  expect(await ui.find({ type: 'Text', text: /4 stories\s+· hide: \/projectstore:bar off/ })).toBeDefined()
  await ui.unmount()
  ui = await mount($, 'terminal', 20, 70)
  expect(await ui.find({ type: 'Text', text: /25%\s+1 done · 2 in work · 1 backlog · 4 stories$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /hide:/ })).toBeUndefined()
  await ui.unmount()

  w.put(BINDING_PATH, binding({ band: { hint_seen: true } }))
  await w.clock.advance(6_000)
  ui = await mount($, 'terminal', 20, 140)
  expect(await ui.find({ type: 'Text', text: /hide:/ })).toBeUndefined()
  await ui.unmount()
})

test('contract 14: words come from the language, English where it has none', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding({ language: 'zh' }), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  await start($, w)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /1 已完成 · 2 进行中 · 1 待办 · 4 个故事/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /this session/ })).toBeDefined()
  await ui.unmount()
})

test('contract 10: the heartbeat follows the session id, and nothing is written under the vault', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS'), [`${SESSIONS}/s2.json`]: pointer('PS-HARNESS') })
  await start($, w)
  const ui = await mount($, 'terminal')
  await w.clock.advance(6_000)
  const first = JSON.parse(w.writes.get(`${SESSIONS}/.band-s1.json`) ?? '{}')
  expect(first.drawn).toBe(true)
  expect(typeof first.drawn_at).toBe('number')

  w.renew('s2')
  await w.clock.advance(6_000)
  expect(JSON.parse(w.writes.get(`${SESSIONS}/.band-s1.json`) ?? '{}').drawn).toBe(false)
  expect(JSON.parse(w.writes.get(`${SESSIONS}/.band-s2.json`) ?? '{}').drawn).toBe(true)
  expect([...w.writes.keys()].filter(p => p.startsWith(`${VAULT}/`))).toEqual([])
  await ui.unmount()
})

test('contract 14: an unreadable epic draws nothing; a missing own epic falls to the pin', async ($, on) => {
  hostBand(on)
  const w = world(on, { [BINDING_PATH]: binding({ band: { epic: 'PS-WT' } }), [`${SESSIONS}/s1.json`]: pointer('PS-GONE') })
  await start($, w)
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚 PS-WT .* · pinned/ })).toBeDefined()
  await ui.unmount()

  w.drop(`${VAULT}/epics/PS-WT/epic.md`)
  await w.clock.advance(6_000)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /the host's own band/ })).toBeDefined()
  await ui.unmount()
})

test('contract 12: a ProjectStore agent gets a row — role, model, the document its prompt names; another agent does not', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  on('agent.spawn', (_$, e) => ({ model: 'claude-opus-5-5', agentId: e.subagentType === 'Explore' ? 'x1' : 'a1' }))
  await start($, w)

  await $.agent.spawn(spawn('Explore', 'Find the hooks.'))
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^\s+agent\s/ })).toBeUndefined()
  await ui.unmount()

  await $.agent.spawn(spawn('projectstore:critic', `Critique ${VAULT}/epics/PS-HARNESS/stories/b.md against adr/README.md.`))
  for (const surface of ['terminal', 'desktop'] as const) {
    ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: /agent critic · opus 5\.5 · reviews «B story»/ })).toBeDefined()
    await ui.unmount()
  }

  // Four rows and a story: the agent's row is the one that goes.
  ui = await mount($, 'terminal', 4)
  expect(await ui.find({ type: 'Text', text: /story A story/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s+agent\s/ })).toBeUndefined()
  await ui.unmount()

  await turn($).complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'ta', agentId: 'a1', reason: 'answer' } as never)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /agent ✓ critic .* · done/ })).toBeDefined()
  await ui.unmount()
  await w.clock.advance(96_000)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^\s+agent\s/ })).toBeUndefined()
  await ui.unmount()
})

test('contract 12: a document not written yet shows by its name; no document, the task as given', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  let next = 'c1'
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: next }))
  await start($, w)
  await $.agent.spawn(spawn('projectstore:clerk', 'Copy the scratch /tmp/s/draft.md to epics/PS-HARNESS/stories/new-story.md and run the ceremony.'))
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /agent clerk · sonnet 5\.5 · writes new-story/ })).toBeDefined()
  await ui.unmount()

  next = 'p1'
  await $.agent.spawn({ ...spawn('projectstore:planner', 'Plan story-058 for the short transposition.'), description: 'Plan story-058 short transposition' })
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /agent planner · sonnet 5\.5 · Plan story-058 short transposition · \+1 more/ })).toBeDefined()
  await ui.unmount()
})

test("contract 12: the model and effort come from the agent's own request over the spawn's", async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  on('agent.spawn', () => ({ model: '', agentId: 'r1' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
  })
  await start($, w)
  await $.agent.spawn({ ...spawn('projectstore:reviewer', 'Review the diff.'), description: 'Review the diff', model: 'sonnet' })
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /agent reviewer · sonnet · Review/ })).toBeDefined()
  await ui.unmount()

  for await (const _ of turn($).step({ turnId: 'tr', index: 0, model: 'claude-sonnet-5-5', effort: 'xhigh', messageCount: 1, agentId: 'r1' })) {
    // drain
  }
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /agent reviewer · sonnet 5\.5 xhigh · / })).toBeDefined()
  await ui.unmount()
})

test("contract 2: two sessions, two epics — each band shows only its own", async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS'), [`${SESSIONS}/s2.json`]: pointer('PS-WT', 'W story') })
  await start($, w)
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚 PS-HARNESS .* · this session/ })).toBeDefined()
  await ui.unmount()
  w.renew('s2')
  await w.clock.advance(6_000)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚 PS-WT .* · this session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /story W story/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PS-HARNESS|A story/ })).toBeUndefined()
  await ui.unmount()
})

test('contract 14: a pointer that cannot be read draws nothing — never the pin in its place', async ($, on) => {
  hostBand(on)
  const w = world(on, { [BINDING_PATH]: binding({ band: { epic: 'PS-WT' } }), [`${SESSIONS}/s1.json`]: '{not json' })
  await start($, w)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /the host's own band/ })).toBeDefined()
  await ui.unmount()
})

test("contract 14: this session's epic.md that cannot be read draws nothing — never the pin in its place", async ($, on) => {
  hostBand(on)
  const w = world(on, { [BINDING_PATH]: binding({ band: { epic: 'PS-WT' } }), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  w.fail(`${VAULT}/epics/PS-HARNESS/epic.md`)
  await start($, w)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /the host's own band/ })).toBeDefined()
  await ui.unmount()
})

test('contract 14: an unreadable story keeps the last good counts; with none yet, no progress row', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  await start($, w)
  let ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /25%\s+1 done · 2 in work · 1 backlog · 4 stories/ })).toBeDefined()
  await ui.unmount()

  // A new story changes the listing, so the stories are read again — and one fails.
  w.put(`${VAULT}/epics/PS-HARNESS/stories/g.md`, '---\nstatus: done\n---\n')
  w.fail(`${VAULT}/epics/PS-HARNESS/stories/a.md`)
  await w.clock.advance(6_000)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /25%\s+1 done · 2 in work · 1 backlog · 4 stories/ })).toBeDefined()
  await ui.unmount()

  w.heal(`${VAULT}/epics/PS-HARNESS/stories/a.md`)
  await w.clock.advance(6_000)
  ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /40%\s+2 done · 2 in work · 1 backlog · 5 stories/ })).toBeDefined()
  await ui.unmount()
})

test('contract 14: stories never read whole draw no progress row, and the head still shows', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  w.fail(`${VAULT}/epics/PS-HARNESS/stories/a.md`)
  await start($, w)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚 PS-HARNESS/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /%\s+\d+ done/ })).toBeUndefined()
  await ui.unmount()
})

test('contract 10: a question keeps the heartbeat fresh — a pause, not an absence', async ($, on) => {
  hostBand(on)
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  await start($, w)
  let ui = await mount($, 'terminal')
  await ui.unmount()
  ui = await mount($, 'terminal', 20, 120, true)
  await w.clock.advance(6_000)
  await w.clock.advance(6_000)
  const beat = JSON.parse(w.writes.get(`${SESSIONS}/.band-s1.json`) ?? '{}')
  expect(beat.drawn).toBe(true)
  expect(beat.drawn_at).toBe(w.clock.now())
  await ui.unmount()
})

test('contract 10: one scan in flight — a hung read is not joined each tick, the band keeps what it had, and a scan hung past 30 s is let go', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  await start($, w)
  const epic = `${VAULT}/epics/PS-HARNESS/epic.md`
  const release = w.hang(epic)
  await w.clock.advance(6_000)
  const first = w.reads(epic)
  await w.clock.advance(6_000)
  await w.clock.advance(6_000)
  expect(w.reads(epic)).toBe(first)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /📚 PS-HARNESS/ })).toBeDefined()
  await ui.unmount()
  await w.clock.advance(30_000)
  expect(w.reads(epic)).toBeGreaterThan(first)
  release()
  await w.clock.settle()
})

test('contract 5: Desktop draws the bar as a grid whose alt names the numbers', async ($, on) => {
  const w = world(on, { [BINDING_PATH]: binding(), [`${SESSIONS}/s1.json`]: pointer('PS-HARNESS') })
  await start($, w)
  const ui = await mount($, 'desktop')
  const svg = (await ui.find({ type: 'Svg' })) as { props: { alt: string; source: string } } | undefined
  expect(svg?.props.alt).toBe('PS-HARNESS: 25%, 1 done, 2 in work, 1 backlog, 4 stories')
  expect(svg?.props.source).toMatch(/^<svg [^>]*>(<rect [^>]*\/>)+<\/svg>$/)
  await ui.unmount()
})
