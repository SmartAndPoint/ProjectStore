// The world beneath the band module in its tests: a project bound to a vault,
// the plugin's own shipped files, an in-memory session state and a clock that
// moves only when the test moves it. Tests have no file system: every file
// the module reads is answered here (the shipped ones by a trimmed copy; the
// node tests read the real ones).

import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

export const ROOT = '/proj'
export const VAULT = '/vault'

export const EN_WORDS: Record<string, string> = {
  band_this_session: 'this session', band_pinned: 'pinned', band_goal: 'goal', band_story: 'story', band_agent: 'agent',
  band_done: 'done', band_in_work: 'in work', band_backlog: 'backlog', band_stories: 'stories', band_no_stories: 'no stories yet',
  band_more: 'more', band_hint: 'hide:', band_ended_done: 'done', band_ended_stopped: 'stopped',
  band_verb_critic: 'reviews', band_verb_reviewer: 'checks the diff against', band_verb_planner: 'plans', band_verb_clerk: 'writes',
  band_verb_librarian: 'curates', band_verb_archaeologist: 'digs for decisions in', band_verb_other: 'works on',
  band_step_reads: 'reads', band_step_writes: 'writes', band_step_edits: 'edits', band_step_searches: 'searches',
  band_step_runs: 'runs', band_step_web: 'searches the web', band_step_vault: 'asks the vault:',
}

// The plugin's shipped files, by the path under its root.
const SHIPPED: Record<string, string> = {
  '.claude-plugin/plugin.json': '{"name":"projectstore","version":"9.9.9"}',
  'templates/en/strings.json': JSON.stringify(EN_WORDS),
  'templates/zh/strings.json': JSON.stringify({ band_done: '已完成', band_in_work: '进行中', band_backlog: '待办', band_stories: '个故事' }),
  'scaffold/headings.json': JSON.stringify({ headings: { goal: { en: ['Goal'], ru: ['Цель'], zh: ['目标'] } } }),
  'scaffold/layouts/engineering.json': JSON.stringify({ folders: [{ kind: 'adr', path: 'adr' }, { kind: 'spec', path: 'specs' }, { kind: 'epic', path: 'epics' }] }),
}

export const story = (status: string | null, title = 'A story') => `---\ntype: story\ntitle: "${title}"\n${status === null ? '' : `status: ${status}\n`}---\n\n# ${title}\n`

// Two epics: PS-HARNESS (a done, b in_progress, c in-progress, d planned,
// e superseded — counts nowhere, f with no status — nowhere) and PS-WT.
export const VAULT_FILES: Record<string, string> = {
  [`${VAULT}/epics/PS-HARNESS/epic.md`]: '---\ntype: epic\nid: "PS-HARNESS"\ntitle: "Harness adapters"\nstatus: planned\n---\n\n# PS-HARNESS\n\n## Goal\n\nShip **ProjectStore** as one [[x|repository]],\none version.\n\nMore text.\n\n## Stories\n',
  [`${VAULT}/epics/PS-HARNESS/stories/a.md`]: story('done'),
  [`${VAULT}/epics/PS-HARNESS/stories/b.md`]: story('in_progress', 'B story'),
  [`${VAULT}/epics/PS-HARNESS/stories/c.md`]: story('in-progress'),
  [`${VAULT}/epics/PS-HARNESS/stories/d.md`]: story('planned'),
  [`${VAULT}/epics/PS-HARNESS/stories/e.md`]: story('superseded'),
  [`${VAULT}/epics/PS-HARNESS/stories/f.md`]: story(null),
  [`${VAULT}/epics/PS-WT/epic.md`]: '---\ntype: epic\nid: "PS-WT"\ntitle: "Parallel sessions"\nstatus: planned\n---\n\n## Goal\n\nTwo sessions, one machine.\n',
  [`${VAULT}/epics/PS-WT/stories/x.md`]: story('done'),
}

export const binding = (extra: Record<string, unknown> = {}) => JSON.stringify({ vault_path: VAULT, layout: 'engineering', language: 'en', ...extra })
// A session pointer naming story `key` of `epic`. Its own title and status
// are deliberately stale: the band reads the story's from the file (contract 8).
export const pointer = (epic: string, key = 'c', title = 'stale pointer title', status = 'planned') =>
  JSON.stringify({ active_epic: epic, active_story: key, story_title: title, story_status: status })

export const BINDING_PATH = `${ROOT}/.projectstore/projectstore.json`
export const SESSIONS = `${ROOT}/.projectstore/state/sessions`

export function world(on: On, files: Record<string, string>, { sid = 's1' }: { sid?: string } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const all = new Map(Object.entries({ ...VAULT_FILES, ...files }))
  // Each path's mtime moves when the test rewrites it, as a real file's does:
  // the band re-reads a story only when a listing's names or mtimes change.
  const version = new Map<string, number>()
  const mtimeOf = (path: string) => 999_000 + (version.get(path) ?? 0)
  const writes = new Map<string, string>()
  const session = { id: sid }
  // Paths whose read throws (an evicted file), paths whose read waits until
  // the test lets it go, and how many times each path was read.
  const failing = new Set<string>()
  const hanging = new Map<string, Promise<void>>()
  const reads = new Map<string, number>()
  const shipped = (path: string) => Object.entries(SHIPPED).find(([rel]) => path.endsWith(`/${rel}`))?.[1]
  const fileAt = (path: string) => all.get(path) ?? writes.get(path) ?? shipped(path)
  const children = (dir: string) => {
    const prefix = dir.replace(/\/+$/, '') + '/'
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of [...all.keys(), ...writes.keys()]) {
      if (!p.startsWith(prefix)) continue
      const [head, ...tail] = p.slice(prefix.length).split('/')
      if (head) names.set(head, tail.length ? 'dir' : 'file')
    }
    return names
  }
  on('session.id', () => ({ value: session.id }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.read', async (_$, e) => {
    reads.set(e.path, (reads.get(e.path) ?? 0) + 1)
    const wait = hanging.get(e.path)
    if (wait) await wait
    if (failing.has(e.path)) throw new Error(`EIO: ${e.path}`)
    const text = fileAt(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.list', (_$, e) => {
    const names = children(e.path)
    if (!names.size) throw new Error(`ENOENT: ${e.path}`)
    const dir = e.path.replace(/\/+$/, '')
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: mtimeOf(`${dir}/${name}`), isLink: false })) }
  })
  on('fs.stat', (_$, e) => {
    if (fileAt(e.path) !== undefined) return { value: { kind: 'file' as const, size: 0, mtimeMs: mtimeOf(e.path), isLink: false } }
    if (children(e.path).size) return { value: { kind: 'dir' as const, size: 0, mtimeMs: 999_000, isLink: false } }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.exists', (_$, e) => ({ value: fileAt(e.path) !== undefined || children(e.path).size > 0 }))
  on('fs.write', (_$, e) => {
    writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return {
    clock,
    writes,
    // What the files say now, for a test that changes one mid-session.
    put: (path: string, text: string) => {
      version.set(path, (version.get(path) ?? 0) + 1)
      all.set(path, text)
    },
    drop: (path: string) => all.delete(path),
    // A /clear: the session gets a new id.
    renew: (id: string) => { session.id = id },
    fail: (path: string) => failing.add(path),
    heal: (path: string) => failing.delete(path),
    // Holds every read of `path` until the returned function is called.
    hang: (path: string) => {
      let release = () => {}
      hanging.set(path, new Promise<void>(r => { release = r }))
      return () => { hanging.delete(path); release() }
    },
    reads: (path: string) => reads.get(path) ?? 0,
  }
}

export const band = (maxRows: number, bodyColumns = 120, hasSurvey = false) => ({ hasSurvey, isWorking: false, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: maxRows }, view: {} })

// An Agent tool call as the engine raises it, beneath the module's agent.spawn hook.
export const spawn = (subagentType: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  tool_use_id: `t-${subagentType}`, prompt, description: `${subagentType} task`, subagentType,
  provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra,
})
