/*
  CentinelAI Inngest Pipeline
  ===========================
  alert_events INSERT
    → centinelai/alert.received
      → deduplicator
        → centinelai/group.created | group.updated
          → scorer (Claude Haiku)
            → centinelai/group.scored
              → correlator (Claude Haiku)
                → centinelai/group.critical  [if score > 70]
                  → notifier (Claude Sonnet)  ← YOU ARE HERE
*/

import { deduplicator } from '@/agents/deduplicator'
import { scorer } from '@/agents/scorer'
import { correlator } from '@/agents/correlator'
import { notifier } from '@/agents/notifier'

export const functions = [deduplicator, scorer, correlator, notifier]
