// projectstore — the band's values in the host's session state ($.state):
// what hooks/band.tsx draws from. Named in .claude-plugin/plugin.json under
// "types", so `claude plugin validate` holds every key the module names to it.

export type BandCounts = { done: number; active: number; backlog: number }

// The epic the band shows and everything its rows need, written by the
// module's clock only when it changed (a write redraws the band).
export type BandView = {
  id: string
  title: string
  goal: string
  // null until the stories have been read whole once: no progress row.
  counts: BandCounts | null
  why: 'this' | 'pinned'
  story: { title: string; status: string | null } | null
  version: string | null
  hint: boolean
  words: Record<string, string>
}

export type BandAgentStatus = 'running' | 'done' | 'error'

// A ProjectStore agent this session spawned: its role, the model and effort
// its own requests name, and the vault document its prompt names.
export type BandAgent = {
  id: string
  role: string
  model: string
  effort: string | null
  subject: string | null
  description: string
  status: BandAgentStatus
  startedAt: number
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    // `steps` is apart from `crew` on purpose: only the terminal's band reads
    // it, so an agent's every step never redraws Desktop's drawing.
    projectstore: { band: BandView | null; crew: BandAgent[]; steps: Record<string, string> }
  }
}
