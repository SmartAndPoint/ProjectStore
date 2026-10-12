// projectstore — band.tsx: the band above the prompt, a Claude Code hooks
// module (hooks.json → "modules").
//
// It shows this session's epic — or a pinned one, in a session with none of
// its own — how far that epic is, its goal, this session's story and the
// ProjectStore agent at work, and nothing while a question is open. It reads
// the binding, this session's pointer and the focused epic's files, writes
// nothing under the vault, and keeps a heartbeat in the session-state
// directory while it draws so the status line can give way to it.
//
// The module runs with no Node: every rule it draws by lives in the Node-free
// scripts/stages.mjs and scripts/band-shared.mjs, which the node tests reach
// directly. This file is the plumbing between those rules and `$`. What it
// remembers between events lives in one Band, made by `register`, so a reload
// starts clean and two loads never share a clock.
//
// Spec: the band above the prompt — rows, heartbeat, command and the status
// line's yield (contracts 2–10, 12, 14).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { foldStages, parseFrontmatter } from '../scripts/stages.mjs'
import {
  AGENT_PREFIX,
  LINGER_MS,
  countsText,
  goalForms,
  goalOf,
  heartbeatFile,
  heartbeatNext,
  isEpicName,
  leadAgent,
  mergeWords,
  modelLabel,
  pctOf,
  phraseOf,
  planRows,
  progressLayout,
  segments,
  stepOf,
  storyFiles,
  storyIsCurrent,
  storyKeyOf,
  storyLayout,
  subjectLabel,
  subjectPath,
  totalOf,
} from '../scripts/band-shared.mjs'
import type { BandAgent, BandCounts, BandView } from './band-state'

// Our own files in a project, as lib.mjs layoutPaths() names them (a node
// test pins these to it).
const BINDING = '.projectstore/projectstore.json'
const SESSIONS = '.projectstore/state/sessions'
// The hint's command token, never translated (a node test pins it to the
// manifest's invocation form).
const HINT_COMMAND = '/projectstore:bar off'

const TICK_MS = 6_000
const DEADLINE_MS = 2_000
// A scan still unsettled after this long is abandoned: its result is ignored
// and the next tick starts a fresh one, so a read that never returns cannot
// freeze the band (or hide a `band off`) for the rest of the session.
const ABANDON_MS = 30_000
// An agent whose end the band never heard (killed, a lost event) leaves the
// row after this long.
const AGENT_MAX_MS = 30 * 60_000

// The terminal's bar: a half-tone mesh, quieter than solid blocks.
const GRID = '▒'
const GRID_DONE = '#73c27c'
const GRID_WORK = '#e0bf55'
const ROLE_C = '#d19a66'
// Desktop's bar: a grid of small cells.
const DONE_C = '#5cc46a'
const WORK_C = '#e3c04a'
const LEFT_C = '#3a3556'

const view = atom({ plugin: 'projectstore', key: 'band' } as const, null as BandView | null)
const crew = atom({ plugin: 'projectstore', key: 'crew' } as const, [] as BandAgent[])
const steps = atom({ plugin: 'projectstore', key: 'steps' } as const, {} as Record<string, string>)

type Json = Record<string, any>
type Rendered = 'drew' | 'survey' | 'nothing' | 'unknown'
// One story file as the scan read it: its key (storyKeyOf), title and status.
type StoryItem = { key: string; title: string | null; status: string | null }
type Stories = { counts: BandCounts; items: StoryItem[] }

// What one load of the module remembers between events.
type Band = {
  lastRender: Rendered
  wasDrawing: boolean
  lastSid: string | null
  ticking: boolean
  gen: number
  scan: { gen: number; startedAt: number } | null
  shownKey: string
  stories: Map<string, { sig: string } & Stories>
  shipped: Map<string, Json>
  place: { vault: string | null; kinds: string[] }
}

function newBand(): Band {
  return {
    lastRender: 'unknown',
    wasDrawing: false,
    lastSid: null,
    ticking: false,
    gen: 0,
    scan: null,
    shownKey: '',
    stories: new Map(),
    shipped: new Map(),
    place: { vault: null, kinds: [] },
  }
}

const UNREADABLE = Symbol('unreadable')

// A JSON file: its value, null when absent, UNREADABLE when it is there and
// cannot be read or parsed — a pointer that exists but does not parse is not
// "no epic", and the band must not fall through to a pin on it.
async function readJsonFile($: EngineInterface, path: string): Promise<Json | null | typeof UNREADABLE> {
  let exists = false
  try {
    exists = await $.fs.exists(path)
  } catch {
    return UNREADABLE
  }
  if (!exists) return null
  try {
    const v = JSON.parse(String(await $.fs.read(path)))
    return v && typeof v === 'object' ? v : UNREADABLE
  } catch {
    return UNREADABLE
  }
}

async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

async function isDir($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path, { resolve: true })).kind === 'dir'
  } catch {
    return false
  }
}

// ── What the plugin ships, read once it reads ─────────────────────────

async function shippedJson($: EngineInterface, b: Band, rel: string): Promise<Json | null> {
  const hit = b.shipped.get(rel)
  if (hit) return hit
  const v = await readJsonFile($, `${$.plugin.root}/${rel}`)
  if (!v || v === UNREADABLE) return null
  b.shipped.set(rel, v)
  return v
}

async function wordsFor($: EngineInterface, b: Band, lang: string) {
  const en = await shippedJson($, b, 'templates/en/strings.json')
  const local = lang && lang !== 'en' ? await shippedJson($, b, `templates/${lang}/strings.json`) : null
  return mergeWords(en, local) as Record<string, string> | null
}

async function versionOf($: EngineInterface, b: Band): Promise<string | null> {
  const m = await shippedJson($, b, '.claude-plugin/plugin.json')
  return m && typeof m.version === 'string' ? m.version : null
}

// The bound layout's epic folder and its kind folders (a subject's path starts
// with one of them).
async function layoutOf($: EngineInterface, b: Band, name: string) {
  const layout = await shippedJson($, b, `scaffold/layouts/${name}.json`)
  const folders: Json[] = Array.isArray(layout?.folders) ? layout!.folders : []
  const epics = folders.find(f => f.kind === 'epic')?.path
  return { epics: typeof epics === 'string' ? epics : null, kinds: folders.map(f => f.path).filter((p): p is string => typeof p === 'string') }
}

// ── The scan (contracts 2, 4–9, 14) ───────────────────────────────────

// The epic's stories by stage, and each one's key, title and status (the
// story row's, contract 8), re-read only when a listing changed. A story that
// cannot be read keeps the last good result (none yet: no progress row and no
// story row), never a partial fold — the band draws less, never wrong.
async function storiesOf($: EngineInterface, b: Band, epicDir: string): Promise<Stories | null> {
  const seen: string[] = []
  const fs = {
    list: async (dir: string) => {
      const entries = await $.fs.list(dir)
      const out = []
      for (const e of entries) {
        let kind = e.kind
        if (kind === 'other') {
          // A symbolic link: the board follows it, so the band does too.
          try { kind = (await $.fs.stat(`${dir}/${e.name}`, { resolve: true })).kind } catch { kind = 'other' }
        }
        seen.push(`${dir}/${e.name}:${kind}:${e.mtimeMs}`)
        out.push({ ...e, kind })
      }
      return out
    },
    exists: async (path: string) => {
      try {
        const st = await $.fs.stat(path, { resolve: true })
        seen.push(`${path}:${st.mtimeMs}`)
        return st.kind === 'file'
      } catch {
        return false
      }
    },
  }
  const files: string[] = await storyFiles(fs, epicDir)
  const sig = seen.sort().join('|')
  const hit = b.stories.get(epicDir)
  if (hit && hit.sig === sig) return hit
  const statuses: unknown[] = []
  const items: StoryItem[] = []
  for (const f of files) {
    const text = await readText($, f)
    // An unreadable story (an evicted iCloud file): the last good result, and
    // nothing cached, so the next scan tries again.
    if (text === null) return hit ?? null
    const data = parseFrontmatter(text).data as Json
    statuses.push(data.status)
    const key = storyKeyOf(f.slice(epicDir.length + 1))
    if (key) {
      items.push({
        key,
        title: typeof data.title === 'string' && data.title ? data.title : null,
        status: data.status === null || data.status === undefined || data.status === '' ? null : String(data.status),
      })
    }
  }
  const next = { sig, counts: foldStages(statuses) as BandCounts, items }
  b.stories.set(epicDir, next)
  return next
}

// This session's story, from its file (contract 8): the item the pointer's
// key names, while it is work the session is moving. Never the pointer's own
// title or status — the pointer can be older than the file.
function storyOf(pointer: Json | null, stories: Stories | null) {
  const key = pointer && typeof pointer.active_story === 'string' ? (pointer.active_story as string) : null
  const item = key && stories ? stories.items.find(i => i.key === key) : null
  if (!item || !storyIsCurrent(item.status)) return null
  return { title: item.title || item.key, status: item.status }
}

async function scan($: EngineInterface, b: Band, root: string, sid: string | null): Promise<BandView | null> {
  const binding = await readJsonFile($, `${root}/${BINDING}`)
  if (!binding || binding === UNREADABLE) return null
  const vault = typeof binding.vault_path === 'string' ? binding.vault_path : null
  if (!vault) return null
  const lay = await layoutOf($, b, typeof binding.layout === 'string' ? binding.layout : 'engineering')
  b.place = { vault, kinds: lay.kinds }
  const band: Json = binding.band && typeof binding.band === 'object' ? binding.band : {}
  if (band.enabled === false || !lay.epics) return null
  const lang = typeof binding.language === 'string' ? binding.language : 'en'
  const words = await wordsFor($, b, lang)
  if (!words) return null

  // This session's epic when its folder exists, else the pin; never another
  // session's. A pointer that cannot be read draws nothing.
  const pointer = sid ? await readJsonFile($, `${root}/${SESSIONS}/${sid}.json`) : null
  if (pointer === UNREADABLE) return null
  const own = pointer && isEpicName(pointer.active_epic) ? (pointer.active_epic as string) : null
  const pin = isEpicName(band.epic) ? (band.epic as string) : null
  let focus: { id: string; why: 'this' | 'pinned' } | null = null
  if (own && (await isDir($, `${vault}/${lay.epics}/${own}`))) focus = { id: own, why: 'this' }
  else if (pin && (await isDir($, `${vault}/${lay.epics}/${pin}`))) focus = { id: pin, why: 'pinned' }
  if (!focus) return null

  // The focused epic's epic.md that cannot be read draws nothing: never the
  // pin in its place.
  const epicDir = `${vault}/${lay.epics}/${focus.id}`
  const text = await readText($, `${epicDir}/epic.md`)
  if (text === null) return null
  const fm = parseFrontmatter(text).data as Json
  const registry = await shippedJson($, b, 'scaffold/headings.json')
  const stories = await storiesOf($, b, epicDir)
  return {
    id: typeof fm.id === 'string' && fm.id ? fm.id : focus.id,
    title: typeof fm.title === 'string' && fm.title ? fm.title : focus.id,
    goal: goalOf(text, goalForms(registry, lang)),
    counts: stories ? stories.counts : null,
    why: focus.why,
    story: focus.why === 'this' ? storyOf(pointer as Json | null, stories) : null,
    version: binding.statusline?.show_version === false ? null : await versionOf($, b),
    hint: band.hint_seen !== true,
    words,
  }
}

// ── The clock: scan, heartbeat, prune (contract 10) ───────────────────

async function writeHeartbeat($: EngineInterface, root: string, sid: string | null, body: unknown): Promise<boolean> {
  const name = heartbeatFile(sid)
  if (!name) return false
  try {
    await $.fs.write(`${root}/${SESSIONS}/${name}`, JSON.stringify(body) + '\n')
    return true
  } catch {
    // A heartbeat missed: the status line keeps its own line, and the next
    // tick tries again.
    return false
  }
}

async function heartbeat($: EngineInterface, b: Band, root: string, sid: string | null, now: number) {
  // A /clear gives the session a new id: the old one's heartbeat stops.
  if (b.lastSid && b.lastSid !== sid && b.wasDrawing) {
    if (await writeHeartbeat($, root, b.lastSid, { drawn: false, drawn_at: now })) b.wasDrawing = false
  }
  b.lastSid = sid
  const body = heartbeatNext(b.lastRender, b.wasDrawing, now)
  if (body && (await writeHeartbeat($, root, sid, body))) b.wasDrawing = body.drawn
}

async function prune($: EngineInterface, now: number) {
  const list = await read($, crew)
  const live = list.filter(a => (a.status === 'running' ? now - a.startedAt < AGENT_MAX_MS : now - (a.endedAt ?? now) < LINGER_MS))
  if (live.length !== list.length) await update($, crew, () => live)
}

async function show($: EngineInterface, b: Band, next: BandView | null) {
  const key = JSON.stringify(next)
  if (key === b.shownKey) return
  b.shownKey = key
  await update($, view, () => next)
}

async function tick($: EngineInterface, b: Band) {
  const now = await $.clock.now()
  const sid = (await $.session.id()) || null
  const root = await $.session.root()
  await heartbeat($, b, root, sid, now)
  await prune($, now)
  // One scan in flight: a scan stuck on an evicted file is not joined by
  // another every tick. One that settles late still shows what it read; one
  // unsettled past ABANDON_MS is let go.
  if (b.scan && now - b.scan.startedAt < ABANDON_MS) return
  const gen = ++b.gen
  b.scan = { gen, startedAt: now }
  const current = () => b.scan?.gen === gen
  const scanning = scan($, b, root, sid)
    .then(next => (current() ? show($, b, next) : undefined))
    .catch(() => undefined)
    .finally(() => {
      if (current()) b.scan = null
    })
  await Promise.race([scanning, $.clock.sleep(DEADLINE_MS)])
}

// A tick that fails (a host refusal, a session that ended) is a tick missed:
// the next one tries again, and nothing it threw goes unhandled.
function safeTick($: EngineInterface, b: Band) {
  return tick($, b).catch(() => undefined)
}

function startClock($: EngineInterface, b: Band) {
  if (b.ticking) return
  b.ticking = true
  void safeTick($, b)
  $.clock.every(TICK_MS, () => {
    void safeTick($, b)
  })
}

// ── Drawing (contracts 3–8, 12) ───────────────────────────────────────

function gridSvg(c: BandCounts, cols: number) {
  const step = 4
  const side = 3
  const rows = 2
  const s = segments(c, cols)
  let cells = ''
  for (let i = 0; i < cols; i++) {
    const fill = i < s.d ? DONE_C : i < s.d + s.a ? WORK_C : LEFT_C
    for (let j = 0; j < rows; j++) cells += `<rect x="${i * step}" y="${j * step + 3}" width="${side}" height="${side}" fill="${fill}"/>`
  }
  const width = cols * step
  const height = rows * step + 4
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${cells}</svg>`, width, height }
}

export const register: Register = on => {
  const b = newBand()

  on('session.start', async ($, e, next) => {
    startClock($, b)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    startClock($, b)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) {
        // A question is a pause, not an absence: the heartbeat stays as it was.
        b.lastRender = b.lastRender === 'drew' || b.lastRender === 'survey' ? 'survey' : 'nothing'
        return next(e)
      }
      const v = await read($, view)
      if (!v) {
        b.lastRender = 'nothing'
        return next(e)
      }
      const els = $.ui.resolve(e)
      const { Box, Text } = els
      const w = v.words
      const now = await $.clock.now()
      const agents = await read($, crew)
      const { lead, others } = leadAgent(agents, now)
      const rows = planRows({ head: true, progress: Boolean(v.counts), goal: Boolean(v.goal), story: Boolean(v.story), agent: Boolean(lead) }, e.props.maxRows)
      if (!rows.length) {
        b.lastRender = 'nothing'
        return next(e)
      }

      const head = (
        <Text wrap="truncate-end">
          {v.version ? <Text dimColor>[PS#{v.version}] </Text> : null}
          <Text bold color="yellow">📚 {v.id}</Text>
          <Text bold> {v.title}</Text>
          <Text dimColor> · {v.why === 'this' ? w.band_this_session : w.band_pinned}</Text>
        </Text>
      )

      const goal = rows.includes('goal') ? <Text dimColor wrap="truncate-end">   {w.band_goal}  {v.goal}</Text> : null

      const hint = v.hint ? `· ${w.band_hint} ${HINT_COMMAND}` : null
      let progress = null
      const c = v.counts
      if (rows.includes('progress') && c) {
        if (!totalOf(c)) {
          progress = (
            <Text wrap="truncate-end">
              <Text dimColor>   {w.band_no_stories}</Text>
              {hint ? <Text dimColor>  {hint}</Text> : null}
            </Text>
          )
        } else {
          const lay = progressLayout(countsText(c, w), hint, e.props.bodyColumns)
          const numbers = (
            <Text wrap="truncate-end">
              <Text bold>{pctOf(c)}%</Text>
              <Text>  </Text>
              <Text color="green">{c.done} {w.band_done}</Text>
              <Text dimColor> · </Text>
              <Text color="yellow">{c.active} {w.band_in_work}</Text>
              <Text dimColor> · {c.backlog} {w.band_backlog} · {totalOf(c)} {w.band_stories}</Text>
              {lay.hint && hint ? <Text dimColor>  {hint}</Text> : null}
            </Text>
          )
          if (e.surface !== 'terminal' && 'Svg' in els) {
            const { Svg } = els
            const cols = Math.max(20, Math.min(80, Math.floor(e.props.bodyColumns / 3)))
            const bar = gridSvg(c, cols)
            progress = (
              <Box flexDirection="row">
                <Text>   </Text>
                <Svg source={bar.source} width={bar.width} height={bar.height} alt={`${v.id}: ${pctOf(c)}%, ${c.done} ${w.band_done}, ${c.active} ${w.band_in_work}, ${c.backlog} ${w.band_backlog}, ${totalOf(c)} ${w.band_stories}`} />
                <Text>  </Text>
                {numbers}
              </Box>
            )
          } else {
            const seg = segments(c, lay.bar)
            progress = (
              <Text wrap="truncate-end">
                <Text>   </Text>
                {lay.bar ? <Text color={GRID_DONE}>{GRID.repeat(seg.d)}</Text> : null}
                {lay.bar ? <Text color={GRID_WORK}>{GRID.repeat(seg.a)}</Text> : null}
                {lay.bar ? <Text dimColor>{GRID.repeat(seg.b)}</Text> : null}
                {lay.bar ? <Text>  </Text> : null}
                {numbers}
              </Text>
            )
          }
        }
      }

      // The title is cut here so the status is never the part the host's
      // truncation takes (contract 8); truncate-end stays as a backstop.
      const sl = v.story ? storyLayout(w.band_story, v.story.title, v.story.status, e.props.bodyColumns) : null
      const story = rows.includes('story') && sl ? (
        <Text wrap="truncate-end">
          <Text dimColor>   {w.band_story} </Text>
          <Text color="cyan">{sl.title}</Text>
          <Text dimColor>{sl.tail}</Text>
        </Text>
      ) : null

      let agent = null
      if (rows.includes('agent') && lead) {
        // The last step on the terminal only: on Desktop each step would
        // redraw the progress drawing, which shows as a blink.
        const step = lead.status === 'running' && e.surface === 'terminal' ? (await read($, steps))[lead.id] : undefined
        const model = modelLabel(lead.model)
        const tail = lead.status === 'running' ? (step ? ` · ${step}` : '') : ` · ${lead.status === 'done' ? w.band_ended_done : w.band_ended_stopped}`
        agent = (
          <Text wrap="truncate-end">
            <Text dimColor>   {w.band_agent} </Text>
            {lead.status === 'done' ? <Text color="green">✓ </Text> : lead.status === 'error' ? <Text color="red">✗ </Text> : null}
            <Text bold color={ROLE_C}>{lead.role}</Text>
            <Text dimColor>{model ? ` · ${model}${lead.effort ? ` ${lead.effort}` : ''}` : ''} · </Text>
            <Text>{phraseOf(lead.role, lead.subject, lead.description, w)}</Text>
            <Text dimColor>{tail}{others ? ` · +${others} ${w.band_more}` : ''}</Text>
          </Text>
        )
      }

      b.lastRender = 'drew'
      return (
        <Box flexDirection="column" paddingX={1}>
          {head}
          {goal}
          {progress}
          {story}
          {agent}
        </Box>
      )
    } catch {
      // A band that cannot draw draws less, never an error: the host's own.
      b.lastRender = 'nothing'
      return next(e)
    }
  })

  // ── ProjectStore's agents (contract 12) ─────────────────────────────

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    try {
      if (ran.agentId && e.subagentType.startsWith(AGENT_PREFIX)) {
        const now = await $.clock.now()
        const rel = subjectPath(e.prompt, b.place.vault, b.place.kinds)
        let title: string | null = null
        if (rel && b.place.vault) {
          const text = await readText($, `${b.place.vault}/${rel}`)
          const t = text === null ? null : (parseFrontmatter(text).data as Json).title
          title = typeof t === 'string' && t ? t : null
        }
        const agent: BandAgent = {
          id: ran.agentId,
          role: e.subagentType.slice(AGENT_PREFIX.length),
          model: ran.model || e.model || '',
          effort: null,
          subject: rel ? subjectLabel(rel, title) : null,
          description: e.description,
          status: 'running',
          startedAt: now,
        }
        await update($, crew, list => [...list.filter(a => a.id !== agent.id && (a.status === 'running' || now - (a.endedAt ?? now) < LINGER_MS)), agent].slice(-12))
      }
    } catch {
      // A view: a spawn it failed to note never holds up the agent.
    }
    return ran
  })

  // The model and effort an agent's own requests name: its first request
  // says, later ones only when they change.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id) {
      try {
        const effort = e.effort === undefined ? null : String(e.effort)
        const agent = (await read($, crew)).find(a => a.id === id)
        if (agent && (agent.model !== e.model || agent.effort !== effort)) {
          await update($, crew, list => list.map(a => (a.id === id ? { ...a, model: e.model, effort } : a)))
        }
      } catch {
        // Never in the way of the request.
      }
    }
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      try {
        const agent = (await read($, crew)).find(a => a.id === id)
        const v = agent?.status === 'running' ? await read($, view) : null
        const step = agent?.status === 'running' && v ? stepOf(e as unknown as Json, b.place.vault, v.words) : null
        if (step && (await read($, steps))[id] !== step) await update($, steps, d => ({ ...d, [id]: step }))
      } catch {
        // A step the band failed to note never holds up the tool.
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      try {
        const now = await $.clock.now()
        const status = e.reason === 'answer' ? ('done' as const) : ('error' as const)
        if ((await read($, crew)).some(a => a.id === id)) {
          await update($, crew, list => list.map(a => (a.id === id ? { ...a, status, endedAt: now } : a)))
        }
        if (id in (await read($, steps))) await update($, steps, d => Object.fromEntries(Object.entries(d).filter(([k]) => k !== id)))
      } catch {
        // Never in the way of the turn.
      }
    }
    return next(e)
  })
}
