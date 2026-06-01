export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      projects: {
        Row: {
          id: string
          name: string
          api_token: string
          onboarding_completed: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          api_token?: string
          onboarding_completed?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          api_token?: string
          onboarding_completed?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      services: {
        Row: {
          id: string
          project_id: string
          name: string
          source: 'kubernetes' | 'gitlab' | 'prometheus' | 'grafana' | 'datadog' | 'slack'
          namespace: string | null
          external_id: string | null
          criticality: number
          labels: Json
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          name: string
          source: 'kubernetes' | 'gitlab' | 'prometheus' | 'grafana' | 'datadog' | 'slack'
          namespace?: string | null
          external_id?: string | null
          criticality?: number
          labels?: Json
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          name?: string
          source?: 'kubernetes' | 'gitlab' | 'prometheus' | 'grafana' | 'datadog' | 'slack'
          namespace?: string | null
          external_id?: string | null
          criticality?: number
          labels?: Json
          created_at?: string
        }
        Relationships: []
      }
      connectors: {
        Row: {
          id: string
          project_id: string
          type: 'kubernetes' | 'gitlab' | 'prometheus' | 'grafana' | 'datadog' | 'slack' | 'pagerduty'
          config: Json
          active: boolean
          verified_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          type: 'kubernetes' | 'gitlab' | 'prometheus' | 'grafana' | 'datadog' | 'slack' | 'pagerduty'
          config?: Json
          active?: boolean
          verified_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          type?: 'kubernetes' | 'gitlab' | 'prometheus' | 'grafana' | 'datadog' | 'slack' | 'pagerduty'
          config?: Json
          active?: boolean
          verified_at?: string | null
          created_at?: string
        }
        Relationships: []
      }
      deploys: {
        Row: {
          id: string
          project_id: string
          project: string
          branch: string | null
          commit_sha: string | null
          author: string | null
          environment: string | null
          status: 'success' | 'failed' | 'running' | null
          deployed_at: string
        }
        Insert: {
          id?: string
          project_id: string
          project: string
          branch?: string | null
          commit_sha?: string | null
          author?: string | null
          environment?: string | null
          status?: 'success' | 'failed' | 'running' | null
          deployed_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          project?: string
          branch?: string | null
          commit_sha?: string | null
          author?: string | null
          environment?: string | null
          status?: 'success' | 'failed' | 'running' | null
          deployed_at?: string
        }
        Relationships: []
      }
      alert_events: {
        Row: {
          id: string
          project_id: string
          service_id: string | null
          source: string
          reason: string
          severity: 'critical' | 'warning' | 'info'
          message: string | null
          raw_payload: Json
          score: number | null
          grouped_id: string | null
          timestamp: string
        }
        Insert: {
          id?: string
          project_id: string
          service_id?: string | null
          source: string
          reason: string
          severity: 'critical' | 'warning' | 'info'
          message?: string | null
          raw_payload?: Json
          score?: number | null
          grouped_id?: string | null
          timestamp?: string
        }
        Update: {
          id?: string
          project_id?: string
          service_id?: string | null
          source?: string
          reason?: string
          severity?: 'critical' | 'warning' | 'info'
          message?: string | null
          raw_payload?: Json
          score?: number | null
          grouped_id?: string | null
          timestamp?: string
        }
        Relationships: []
      }
      alert_groups: {
        Row: {
          id: string
          project_id: string
          service_ids: string[]
          event_ids: string[]
          score: number | null
          score_reason: string | null
          correlated: boolean
          notified: boolean
          snoozed_until: string | null
          feedback: 'ignored' | 'acted' | 'escalated' | 'snoozed' | null
          window_start: string | null
          window_end: string | null
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          service_ids?: string[]
          event_ids?: string[]
          score?: number | null
          score_reason?: string | null
          correlated?: boolean
          notified?: boolean
          snoozed_until?: string | null
          feedback?: 'ignored' | 'acted' | 'escalated' | 'snoozed' | null
          window_start?: string | null
          window_end?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          service_ids?: string[]
          event_ids?: string[]
          score?: number | null
          score_reason?: string | null
          correlated?: boolean
          notified?: boolean
          snoozed_until?: string | null
          feedback?: 'ignored' | 'acted' | 'escalated' | 'snoozed' | null
          window_start?: string | null
          window_end?: string | null
          created_at?: string
        }
        Relationships: []
      }
      incidents: {
        Row: {
          id: string
          project_id: string
          group_id: string | null
          title: string
          severity: 'critical' | 'high' | 'medium' | 'low'
          status: 'open' | 'investigating' | 'resolved'
          postmortem: string | null
          embedding: number[] | null
          started_at: string
          resolved_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          group_id?: string | null
          title: string
          severity: 'critical' | 'high' | 'medium' | 'low'
          status?: 'open' | 'investigating' | 'resolved'
          postmortem?: string | null
          embedding?: number[] | null
          started_at?: string
          resolved_at?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          group_id?: string | null
          title?: string
          severity?: 'critical' | 'high' | 'medium' | 'low'
          status?: 'open' | 'investigating' | 'resolved'
          postmortem?: string | null
          embedding?: number[] | null
          started_at?: string
          resolved_at?: string | null
        }
        Relationships: []
      }
      snoozed_groups: {
        Row: {
          id: string
          project_id: string
          group_id: string
          expires_at: string
          created_at: string
        }
        Insert: {
          id?: string
          project_id: string
          group_id: string
          expires_at: string
          created_at?: string
        }
        Update: {
          id?: string
          project_id?: string
          group_id?: string
          expires_at?: string
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: {
      auth_project_id: {
        Args: { [_ in never]: never }
        Returns: string
      }
    }
    Enums: { [_ in never]: never }
  }
}

// ─── Convenience type aliases ─────────────────────────────────────────────────

type Tables = Database['public']['Tables']

export type Project       = Tables['projects']['Row']
export type ProjectInsert = Tables['projects']['Insert']
export type ProjectUpdate = Tables['projects']['Update']

export type Service        = Tables['services']['Row']
export type ServiceInsert  = Tables['services']['Insert']
export type ServiceUpdate  = Tables['services']['Update']

export type Connector       = Tables['connectors']['Row']
export type ConnectorInsert = Tables['connectors']['Insert']
export type ConnectorUpdate = Tables['connectors']['Update']

export type Deploy       = Tables['deploys']['Row']
export type DeployInsert = Tables['deploys']['Insert']
export type DeployUpdate = Tables['deploys']['Update']

export type AlertEvent       = Tables['alert_events']['Row']
export type AlertEventInsert = Tables['alert_events']['Insert']
export type AlertEventUpdate = Tables['alert_events']['Update']

export type AlertGroup       = Tables['alert_groups']['Row']
export type AlertGroupInsert = Tables['alert_groups']['Insert']
export type AlertGroupUpdate = Tables['alert_groups']['Update']

export type Incident       = Tables['incidents']['Row']
export type IncidentInsert = Tables['incidents']['Insert']
export type IncidentUpdate = Tables['incidents']['Update']

export type SnoozedGroup       = Tables['snoozed_groups']['Row']
export type SnoozedGroupInsert = Tables['snoozed_groups']['Insert']
export type SnoozedGroupUpdate = Tables['snoozed_groups']['Update']

// ─── Domain enums ─────────────────────────────────────────────────────────────

export type ServiceSource    = Service['source']
export type ConnectorType    = Connector['type']
export type DeployStatus     = NonNullable<Deploy['status']>
export type AlertSeverity    = AlertEvent['severity']
export type AlertFeedback    = NonNullable<AlertGroup['feedback']>
export type IncidentSeverity = Incident['severity']
export type IncidentStatus   = Incident['status']
