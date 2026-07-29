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
      ai_family_usage_locks: {
        Row: {
          created_at: string
          family_id: string
        }
        Insert: {
          created_at?: string
          family_id: string
        }
        Update: {
          created_at?: string
          family_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_family_usage_locks_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: true
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_image_generation_admissions: {
        Row: {
          admission_ordinal: number
          admitted_at: string
          finalized_at: string | null
          id: number
          request_id: string
          reserved_until: string
          state: string
          utc_day: string
          utc_month: string
        }
        Insert: {
          admission_ordinal: number
          admitted_at?: string
          finalized_at?: string | null
          id?: number
          request_id: string
          reserved_until: string
          state: string
          utc_day: string
          utc_month: string
        }
        Update: {
          admission_ordinal?: number
          admitted_at?: string
          finalized_at?: string | null
          id?: number
          request_id?: string
          reserved_until?: string
          state?: string
          utc_day?: string
          utc_month?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_image_generation_admissions_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "ai_image_generation_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_image_generation_admissions_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "ai_usage_observability_gaps"
            referencedColumns: ["usage_request_id"]
          },
        ]
      }
      ai_image_generation_requests: {
        Row: {
          actor_user_id: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          consumed_at: string | null
          created_at: string
          enforcement_epoch: number
          family_id: string
          id: string
          protocol_version: number
          provider_attempt_count: number
          request_intent: string
          state: string
          target_id: string
          target_kind: string
        }
        Insert: {
          actor_user_id?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          consumed_at?: string | null
          created_at?: string
          enforcement_epoch: number
          family_id: string
          id: string
          protocol_version?: number
          provider_attempt_count?: number
          request_intent: string
          state?: string
          target_id: string
          target_kind: string
        }
        Update: {
          actor_user_id?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          consumed_at?: string | null
          created_at?: string
          enforcement_epoch?: number
          family_id?: string
          id?: string
          protocol_version?: number
          provider_attempt_count?: number
          request_intent?: string
          state?: string
          target_id?: string
          target_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_image_generation_requests_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_provider_attempts: {
        Row: {
          attempt_number: number
          id: number
          provider: string
          request_id: string
          reserved_at: string
        }
        Insert: {
          attempt_number: number
          id?: number
          provider: string
          request_id: string
          reserved_at?: string
        }
        Update: {
          attempt_number?: number
          id?: number
          provider?: string
          request_id?: string
          reserved_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_provider_attempts_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "ai_image_generation_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_provider_attempts_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "ai_usage_observability_gaps"
            referencedColumns: ["usage_request_id"]
          },
        ]
      }
      ai_usage_alert_outbox: {
        Row: {
          attempts: number
          claim_started_at: string | null
          claim_token: string | null
          created_at: string
          environment_id: string
          family_id: string | null
          id: string
          idempotency_key: string
          kind: string
          payload: Json
          period_start: string
          policy_version: number
          sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          claim_started_at?: string | null
          claim_token?: string | null
          created_at?: string
          environment_id: string
          family_id?: string | null
          id?: string
          idempotency_key: string
          kind: string
          payload?: Json
          period_start: string
          policy_version: number
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          claim_started_at?: string | null
          claim_token?: string | null
          created_at?: string
          environment_id?: string
          family_id?: string | null
          id?: string
          idempotency_key?: string
          kind?: string
          payload?: Json
          period_start?: string
          policy_version?: number
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_alert_outbox_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_events: {
        Row: {
          actor_user_id: string | null
          ai_call_id: string
          audio_seconds: number | null
          billing_status: string
          cached_input_tokens: number | null
          cost_basis: string
          cost_is_complete: boolean
          created_at: string
          estimated_cost_usd: number | null
          family_id: string
          id: string
          input_image_tokens: number | null
          input_text_tokens: number | null
          model: string
          operation: string
          output_image_tokens: number | null
          output_text_tokens: number | null
          pricing_version: string | null
          provider: string | null
          provider_usage: Json
          request_intent: string | null
          success: boolean
          usage_request_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          ai_call_id: string
          audio_seconds?: number | null
          billing_status?: string
          cached_input_tokens?: number | null
          cost_basis?: string
          cost_is_complete?: boolean
          created_at?: string
          estimated_cost_usd?: number | null
          family_id: string
          id?: string
          input_image_tokens?: number | null
          input_text_tokens?: number | null
          model: string
          operation: string
          output_image_tokens?: number | null
          output_text_tokens?: number | null
          pricing_version?: string | null
          provider?: string | null
          provider_usage?: Json
          request_intent?: string | null
          success: boolean
          usage_request_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          ai_call_id?: string
          audio_seconds?: number | null
          billing_status?: string
          cached_input_tokens?: number | null
          cost_basis?: string
          cost_is_complete?: boolean
          created_at?: string
          estimated_cost_usd?: number | null
          family_id?: string
          id?: string
          input_image_tokens?: number | null
          input_text_tokens?: number | null
          model?: string
          operation?: string
          output_image_tokens?: number | null
          output_text_tokens?: number | null
          pricing_version?: string | null
          provider?: string | null
          provider_usage?: Json
          request_intent?: string | null
          success?: boolean
          usage_request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_events_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_usage_request_id_fkey"
            columns: ["usage_request_id"]
            isOneToOne: false
            referencedRelation: "ai_image_generation_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_usage_request_id_fkey"
            columns: ["usage_request_id"]
            isOneToOne: false
            referencedRelation: "ai_usage_observability_gaps"
            referencedColumns: ["usage_request_id"]
          },
        ]
      }
      ai_usage_limit_notices: {
        Row: {
          actor_user_id: string
          created_at: string
          dismissed_at: string | null
          family_id: string
          id: string
          quota_policy_epoch: number
          retry_after: string
          scope: string
          target_id: string
          target_kind: string
        }
        Insert: {
          actor_user_id: string
          created_at?: string
          dismissed_at?: string | null
          family_id: string
          id?: string
          quota_policy_epoch: number
          retry_after: string
          scope: string
          target_id: string
          target_kind: string
        }
        Update: {
          actor_user_id?: string
          created_at?: string
          dismissed_at?: string | null
          family_id?: string
          id?: string
          quota_policy_epoch?: number
          retry_after?: string
          scope?: string
          target_id?: string
          target_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_limit_notices_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_monthly_rollups: {
        Row: {
          calls: number
          estimated_cost_usd: number
          failed_calls: number
          family_id: string
          model: string
          month: string
          operation: string
          unpriced_calls: number
          updated_at: string
        }
        Insert: {
          calls?: number
          estimated_cost_usd?: number
          failed_calls?: number
          family_id: string
          model: string
          month: string
          operation: string
          unpriced_calls?: number
          updated_at?: string
        }
        Update: {
          calls?: number
          estimated_cost_usd?: number
          failed_calls?: number
          family_id?: string
          model?: string
          month?: string
          operation?: string
          unpriced_calls?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_monthly_rollups_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_settings: {
        Row: {
          alert_policy_version: number
          enforcement_activated_at: string | null
          enforcement_enabled: boolean
          family_monthly_spend_alert_usd: number
          family_request_alert_fraction: number
          family_unpriced_alert_min_calls: number
          global_fallback_alert_fraction: number
          global_fallback_alert_min_calls: number
          global_unpriced_alert_fraction: number
          global_unpriced_alert_min_calls: number
          image_requests_per_family_per_day: number
          image_requests_per_family_per_month: number
          manual_regenerations_per_memory_per_day: number
          max_alert_outbox_attempts: number
          observability_gap_alert_minutes: number
          quota_policy_epoch: number
          singleton: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          alert_policy_version?: number
          enforcement_activated_at?: string | null
          enforcement_enabled?: boolean
          family_monthly_spend_alert_usd?: number
          family_request_alert_fraction?: number
          family_unpriced_alert_min_calls?: number
          global_fallback_alert_fraction?: number
          global_fallback_alert_min_calls?: number
          global_unpriced_alert_fraction?: number
          global_unpriced_alert_min_calls?: number
          image_requests_per_family_per_day?: number
          image_requests_per_family_per_month?: number
          manual_regenerations_per_memory_per_day?: number
          max_alert_outbox_attempts?: number
          observability_gap_alert_minutes?: number
          quota_policy_epoch?: number
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          alert_policy_version?: number
          enforcement_activated_at?: string | null
          enforcement_enabled?: boolean
          family_monthly_spend_alert_usd?: number
          family_request_alert_fraction?: number
          family_unpriced_alert_min_calls?: number
          global_fallback_alert_fraction?: number
          global_fallback_alert_min_calls?: number
          global_unpriced_alert_fraction?: number
          global_unpriced_alert_min_calls?: number
          image_requests_per_family_per_day?: number
          image_requests_per_family_per_month?: number
          manual_regenerations_per_memory_per_day?: number
          max_alert_outbox_attempts?: number
          observability_gap_alert_minutes?: number
          quota_policy_epoch?: number
          singleton?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      blocked_family_accounts: {
        Row: {
          blocked_membership_id: string | null
          blocked_user_id: string
          blocker_user_id: string
          created_at: string
          family_id: string
          id: string
        }
        Insert: {
          blocked_membership_id?: string | null
          blocked_user_id: string
          blocker_user_id: string
          created_at?: string
          family_id: string
          id?: string
        }
        Update: {
          blocked_membership_id?: string | null
          blocked_user_id?: string
          blocker_user_id?: string
          created_at?: string
          family_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocked_family_accounts_blocked_membership_id_fkey"
            columns: ["blocked_membership_id"]
            isOneToOne: false
            referencedRelation: "family_memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocked_family_accounts_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      content_report_email_alerts: {
        Row: {
          attempt_count: number
          attempt_token: string | null
          last_attempt_at: string | null
          report_id: string
          sent_at: string | null
          status: string
        }
        Insert: {
          attempt_count?: number
          attempt_token?: string | null
          last_attempt_at?: string | null
          report_id: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          attempt_count?: number
          attempt_token?: string | null
          last_attempt_at?: string | null
          report_id?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_report_email_alerts_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: true
            referencedRelation: "content_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      content_reports: {
        Row: {
          created_at: string
          family_id: string
          id: string
          note: string | null
          reason: string
          reporter_user_id: string | null
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          target_id: string
          target_type: string
          target_user_id: string | null
          target_version_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          family_id: string
          id?: string
          note?: string | null
          reason: string
          reporter_user_id?: string | null
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_id: string
          target_type: string
          target_user_id?: string | null
          target_version_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          family_id?: string
          id?: string
          note?: string | null
          reason?: string
          reporter_user_id?: string | null
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_id?: string
          target_type?: string
          target_user_id?: string | null
          target_version_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_reports_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      families: {
        Row: {
          account_deletion_token: string | null
          created_at: string
          deleted_at: string | null
          deletion_fence_started_at: string | null
          deletion_fence_token: string | null
          id: string
          illustration_style: string
          name: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          account_deletion_token?: string | null
          created_at?: string
          deleted_at?: string | null
          deletion_fence_started_at?: string | null
          deletion_fence_token?: string | null
          id?: string
          illustration_style?: string
          name: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          account_deletion_token?: string | null
          created_at?: string
          deleted_at?: string | null
          deletion_fence_started_at?: string | null
          deletion_fence_token?: string | null
          id?: string
          illustration_style?: string
          name?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      family_activity_log: {
        Row: {
          actor_id: string
          created_at: string
          family_id: string
          kind: string
        }
        Insert: {
          actor_id: string
          created_at?: string
          family_id: string
          kind: string
        }
        Update: {
          actor_id?: string
          created_at?: string
          family_id?: string
          kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_activity_log_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      family_invites: {
        Row: {
          code: string
          created_at: string
          expires_at: string
          family_id: string
          id: string
          invited_by: string
          redeemed_at: string | null
          redeemed_by: string | null
          resolved_at: string | null
          resolved_by: string | null
          role: string
          status: string
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          expires_at?: string
          family_id: string
          id?: string
          invited_by: string
          redeemed_at?: string | null
          redeemed_by?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          role: string
          status?: string
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          expires_at?: string
          family_id?: string
          id?: string
          invited_by?: string
          redeemed_at?: string | null
          redeemed_by?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          role?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_invites_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      family_member_portrait_versions: {
        Row: {
          created_at: string
          date_source: string
          deletion_started_at: string | null
          deletion_token: string | null
          family_id: string
          family_member_id: string
          generation_output_key: string | null
          generation_started_at: string | null
          generation_token: string | null
          id: string
          illustrated_profile_key: string | null
          illustrated_profile_status: string
          profile_picture_key: string
          reference_date: string | null
          updated_at: string
          usage_limit_epoch: number | null
          usage_limit_retry_after: string | null
          usage_limit_scope: string | null
          usage_preparation_deadline_at: string | null
          usage_preparation_input_updated_at: string | null
          usage_preparation_ordinal: number | null
          usage_preparation_request_id: string | null
          usage_preparation_token: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          date_source: string
          deletion_started_at?: string | null
          deletion_token?: string | null
          family_id: string
          family_member_id: string
          generation_output_key?: string | null
          generation_started_at?: string | null
          generation_token?: string | null
          id: string
          illustrated_profile_key?: string | null
          illustrated_profile_status?: string
          profile_picture_key: string
          reference_date?: string | null
          updated_at?: string
          usage_limit_epoch?: number | null
          usage_limit_retry_after?: string | null
          usage_limit_scope?: string | null
          usage_preparation_deadline_at?: string | null
          usage_preparation_input_updated_at?: string | null
          usage_preparation_ordinal?: number | null
          usage_preparation_request_id?: string | null
          usage_preparation_token?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          date_source?: string
          deletion_started_at?: string | null
          deletion_token?: string | null
          family_id?: string
          family_member_id?: string
          generation_output_key?: string | null
          generation_started_at?: string | null
          generation_token?: string | null
          id?: string
          illustrated_profile_key?: string | null
          illustrated_profile_status?: string
          profile_picture_key?: string
          reference_date?: string | null
          updated_at?: string
          usage_limit_epoch?: number | null
          usage_limit_retry_after?: string | null
          usage_limit_scope?: string | null
          usage_preparation_deadline_at?: string | null
          usage_preparation_input_updated_at?: string | null
          usage_preparation_ordinal?: number | null
          usage_preparation_request_id?: string | null
          usage_preparation_token?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "family_member_portrait_versio_usage_preparation_request_id_fkey"
            columns: ["usage_preparation_request_id"]
            isOneToOne: false
            referencedRelation: "ai_image_generation_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "family_member_portrait_versio_usage_preparation_request_id_fkey"
            columns: ["usage_preparation_request_id"]
            isOneToOne: false
            referencedRelation: "ai_usage_observability_gaps"
            referencedColumns: ["usage_request_id"]
          },
          {
            foreignKeyName: "family_member_portrait_versions_member_family_fkey"
            columns: ["family_member_id", "family_id"]
            isOneToOne: false
            referencedRelation: "family_members"
            referencedColumns: ["id", "family_id"]
          },
        ]
      }
      family_members: {
        Row: {
          additional_info: string | null
          created_at: string
          date_of_birth: string | null
          deletion_fence_started_at: string | null
          deletion_fence_token: string | null
          family_id: string
          gender: string | null
          id: string
          illustrated_profile_key: string | null
          illustrated_profile_status: string
          is_user_profile: boolean
          name: string
          nicknames: string[] | null
          profile_picture_key: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          additional_info?: string | null
          created_at?: string
          date_of_birth?: string | null
          deletion_fence_started_at?: string | null
          deletion_fence_token?: string | null
          family_id: string
          gender?: string | null
          id?: string
          illustrated_profile_key?: string | null
          illustrated_profile_status?: string
          is_user_profile?: boolean
          name: string
          nicknames?: string[] | null
          profile_picture_key?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          additional_info?: string | null
          created_at?: string
          date_of_birth?: string | null
          deletion_fence_started_at?: string | null
          deletion_fence_token?: string | null
          family_id?: string
          gender?: string | null
          id?: string
          illustrated_profile_key?: string | null
          illustrated_profile_status?: string
          is_user_profile?: boolean
          name?: string
          nicknames?: string[] | null
          profile_picture_key?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "family_members_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      family_memberships: {
        Row: {
          created_at: string
          family_id: string
          id: string
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          family_id: string
          id?: string
          role: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          family_id?: string
          id?: string
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_memberships_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      invite_code_words: {
        Row: {
          word: string
        }
        Insert: {
          word: string
        }
        Update: {
          word?: string
        }
        Relationships: []
      }
      invite_redemption_attempts: {
        Row: {
          attempted_at: string
          ip: string | null
          user_id: string
        }
        Insert: {
          attempted_at?: string
          ip?: string | null
          user_id: string
        }
        Update: {
          attempted_at?: string
          ip?: string | null
          user_id?: string
        }
        Relationships: []
      }
      memories: {
        Row: {
          content: string | null
          created_at: string
          emotion: string | null
          family_id: string
          id: string
          illustration_generation_attempt_id: string | null
          illustration_generation_id: string | null
          illustration_generation_started_at: string | null
          illustration_key: string | null
          illustration_prompt: string | null
          illustration_status: string
          link_previews: Json
          media_content_type: string | null
          media_key: string | null
          memory_date: string
          memory_type: string
          updated_at: string
          usage_limit_epoch: number | null
          usage_limit_retry_after: string | null
          usage_limit_scope: string | null
          usage_preparation_deadline_at: string | null
          usage_preparation_input_updated_at: string | null
          usage_preparation_ordinal: number | null
          usage_preparation_request_id: string | null
          usage_preparation_token: string | null
          user_id: string | null
        }
        Insert: {
          content?: string | null
          created_at?: string
          emotion?: string | null
          family_id: string
          id?: string
          illustration_generation_attempt_id?: string | null
          illustration_generation_id?: string | null
          illustration_generation_started_at?: string | null
          illustration_key?: string | null
          illustration_prompt?: string | null
          illustration_status?: string
          link_previews?: Json
          media_content_type?: string | null
          media_key?: string | null
          memory_date?: string
          memory_type?: string
          updated_at?: string
          usage_limit_epoch?: number | null
          usage_limit_retry_after?: string | null
          usage_limit_scope?: string | null
          usage_preparation_deadline_at?: string | null
          usage_preparation_input_updated_at?: string | null
          usage_preparation_ordinal?: number | null
          usage_preparation_request_id?: string | null
          usage_preparation_token?: string | null
          user_id?: string | null
        }
        Update: {
          content?: string | null
          created_at?: string
          emotion?: string | null
          family_id?: string
          id?: string
          illustration_generation_attempt_id?: string | null
          illustration_generation_id?: string | null
          illustration_generation_started_at?: string | null
          illustration_key?: string | null
          illustration_prompt?: string | null
          illustration_status?: string
          link_previews?: Json
          media_content_type?: string | null
          media_key?: string | null
          memory_date?: string
          memory_type?: string
          updated_at?: string
          usage_limit_epoch?: number | null
          usage_limit_retry_after?: string | null
          usage_limit_scope?: string | null
          usage_preparation_deadline_at?: string | null
          usage_preparation_input_updated_at?: string | null
          usage_preparation_ordinal?: number | null
          usage_preparation_request_id?: string | null
          usage_preparation_token?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "memories_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memories_usage_preparation_request_id_fkey"
            columns: ["usage_preparation_request_id"]
            isOneToOne: false
            referencedRelation: "ai_image_generation_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memories_usage_preparation_request_id_fkey"
            columns: ["usage_preparation_request_id"]
            isOneToOne: false
            referencedRelation: "ai_usage_observability_gaps"
            referencedColumns: ["usage_request_id"]
          },
        ]
      }
      memory_comments: {
        Row: {
          content: string
          created_at: string
          id: string
          memory_id: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          memory_id: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          memory_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_comments_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_family_members: {
        Row: {
          family_member_id: string
          memory_id: string
        }
        Insert: {
          family_member_id: string
          memory_id: string
        }
        Update: {
          family_member_id?: string
          memory_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_family_members_family_member_id_fkey"
            columns: ["family_member_id"]
            isOneToOne: false
            referencedRelation: "family_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_family_members_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_illustration_jobs: {
        Row: {
          attempt_id: string
          color_palette: string
          completed_at: string | null
          created_at: string
          emotion: string | null
          error_code: string | null
          expression_style: string | null
          fallback_attempts: number
          family_id: string
          id: string
          illustration_prompt: string | null
          last_upload_completed_token: string | null
          memory_date: string
          memory_id: string
          model: string | null
          old_illustration_key: string | null
          output_key: string
          primary_attempts: number
          provider_deadline_at: string
          reference_candidates: Json
          request_intent: string
          safe_scene_description: string | null
          started_at: string
          status: string
          style_description: string | null
          updated_at: string
          upload_started_at: string | null
          upload_token: string | null
          usage_enforcement_epoch: number | null
          usage_enforcement_required: boolean
          usage_protocol_version: number
          usage_request_id: string | null
          workflow_instance_id: string
        }
        Insert: {
          attempt_id: string
          color_palette: string
          completed_at?: string | null
          created_at?: string
          emotion?: string | null
          error_code?: string | null
          expression_style?: string | null
          fallback_attempts?: number
          family_id: string
          id: string
          illustration_prompt?: string | null
          last_upload_completed_token?: string | null
          memory_date: string
          memory_id: string
          model?: string | null
          old_illustration_key?: string | null
          output_key: string
          primary_attempts?: number
          provider_deadline_at: string
          reference_candidates?: Json
          request_intent: string
          safe_scene_description?: string | null
          started_at?: string
          status?: string
          style_description?: string | null
          updated_at?: string
          upload_started_at?: string | null
          upload_token?: string | null
          usage_enforcement_epoch?: number | null
          usage_enforcement_required?: boolean
          usage_protocol_version?: number
          usage_request_id?: string | null
          workflow_instance_id: string
        }
        Update: {
          attempt_id?: string
          color_palette?: string
          completed_at?: string | null
          created_at?: string
          emotion?: string | null
          error_code?: string | null
          expression_style?: string | null
          fallback_attempts?: number
          family_id?: string
          id?: string
          illustration_prompt?: string | null
          last_upload_completed_token?: string | null
          memory_date?: string
          memory_id?: string
          model?: string | null
          old_illustration_key?: string | null
          output_key?: string
          primary_attempts?: number
          provider_deadline_at?: string
          reference_candidates?: Json
          request_intent?: string
          safe_scene_description?: string | null
          started_at?: string
          status?: string
          style_description?: string | null
          updated_at?: string
          upload_started_at?: string | null
          upload_token?: string | null
          usage_enforcement_epoch?: number | null
          usage_enforcement_required?: boolean
          usage_protocol_version?: number
          usage_request_id?: string | null
          workflow_instance_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_illustration_jobs_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_illustration_jobs_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_illustration_jobs_usage_request_id_fkey"
            columns: ["usage_request_id"]
            isOneToOne: false
            referencedRelation: "ai_image_generation_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memory_illustration_jobs_usage_request_id_fkey"
            columns: ["usage_request_id"]
            isOneToOne: false
            referencedRelation: "ai_usage_observability_gaps"
            referencedColumns: ["usage_request_id"]
          },
        ]
      }
      memory_illustration_workflow_bridge_nonces: {
        Row: {
          nonce: string
          received_at: string
        }
        Insert: {
          nonce: string
          received_at?: string
        }
        Update: {
          nonce?: string
          received_at?: string
        }
        Relationships: []
      }
      memory_likes: {
        Row: {
          created_at: string
          memory_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          memory_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          memory_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_likes_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_media: {
        Row: {
          aspect_ratio: number | null
          content_type: string
          created_at: string
          duration_ms: number | null
          id: string
          memory_id: string
          object_key: string
          position: number
          preview_object_key: string | null
          updated_at: string
        }
        Insert: {
          aspect_ratio?: number | null
          content_type: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          memory_id: string
          object_key: string
          position: number
          preview_object_key?: string | null
          updated_at?: string
        }
        Update: {
          aspect_ratio?: number | null
          content_type?: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          memory_id?: string
          object_key?: string
          position?: number
          preview_object_key?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_media_memory_id_fkey"
            columns: ["memory_id"]
            isOneToOne: false
            referencedRelation: "memories"
            referencedColumns: ["id"]
          },
        ]
      }
      portrait_generation_jobs: {
        Row: {
          actor_user_id: string | null
          attempt_id: string
          completed_at: string | null
          created_at: string
          error_code: string | null
          fallback_attempts: number
          family_id: string
          id: string
          last_upload_completed_token: string | null
          model: string | null
          old_portrait_key: string | null
          output_key: string
          portrait_prompt: string | null
          portrait_version_id: string
          primary_attempts: number
          provider_deadline_at: string
          request_intent: string
          source_photo_key: string | null
          started_at: string
          status: string
          style_reference_key: string | null
          updated_at: string
          upload_started_at: string | null
          upload_token: string | null
          usage_enforcement_epoch: number | null
          usage_enforcement_required: boolean
          usage_protocol_version: number
          usage_request_id: string | null
          workflow_instance_id: string
        }
        Insert: {
          actor_user_id?: string | null
          attempt_id: string
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          fallback_attempts?: number
          family_id: string
          id: string
          last_upload_completed_token?: string | null
          model?: string | null
          old_portrait_key?: string | null
          output_key: string
          portrait_prompt?: string | null
          portrait_version_id: string
          primary_attempts?: number
          provider_deadline_at: string
          request_intent: string
          source_photo_key?: string | null
          started_at?: string
          status?: string
          style_reference_key?: string | null
          updated_at?: string
          upload_started_at?: string | null
          upload_token?: string | null
          usage_enforcement_epoch?: number | null
          usage_enforcement_required?: boolean
          usage_protocol_version?: number
          usage_request_id?: string | null
          workflow_instance_id: string
        }
        Update: {
          actor_user_id?: string | null
          attempt_id?: string
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          fallback_attempts?: number
          family_id?: string
          id?: string
          last_upload_completed_token?: string | null
          model?: string | null
          old_portrait_key?: string | null
          output_key?: string
          portrait_prompt?: string | null
          portrait_version_id?: string
          primary_attempts?: number
          provider_deadline_at?: string
          request_intent?: string
          source_photo_key?: string | null
          started_at?: string
          status?: string
          style_reference_key?: string | null
          updated_at?: string
          upload_started_at?: string | null
          upload_token?: string | null
          usage_enforcement_epoch?: number | null
          usage_enforcement_required?: boolean
          usage_protocol_version?: number
          usage_request_id?: string | null
          workflow_instance_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "portrait_generation_jobs_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portrait_generation_jobs_portrait_version_id_fkey"
            columns: ["portrait_version_id"]
            isOneToOne: false
            referencedRelation: "family_member_portrait_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portrait_generation_jobs_usage_request_id_fkey"
            columns: ["usage_request_id"]
            isOneToOne: false
            referencedRelation: "ai_image_generation_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portrait_generation_jobs_usage_request_id_fkey"
            columns: ["usage_request_id"]
            isOneToOne: false
            referencedRelation: "ai_usage_observability_gaps"
            referencedColumns: ["usage_request_id"]
          },
        ]
      }
      portrait_generation_workflow_bridge_nonces: {
        Row: {
          nonce: string
          received_at: string
        }
        Insert: {
          nonce: string
          received_at?: string
        }
        Update: {
          nonce?: string
          received_at?: string
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          account_deletion_token: string | null
          active_family_id: string | null
          created_at: string
          deleted_at: string | null
          enable_daily_reminder: boolean
          expo_push_token: string | null
          hard_delete_started_at: string | null
          hard_delete_token: string | null
          has_completed_onboarding: boolean
          id: string
          name: string
          notification_time: string | null
          notify_engagement: boolean
          notify_new_memories: boolean
          scheduled_hard_delete_at: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          account_deletion_token?: string | null
          active_family_id?: string | null
          created_at?: string
          deleted_at?: string | null
          enable_daily_reminder?: boolean
          expo_push_token?: string | null
          hard_delete_started_at?: string | null
          hard_delete_token?: string | null
          has_completed_onboarding?: boolean
          id: string
          name: string
          notification_time?: string | null
          notify_engagement?: boolean
          notify_new_memories?: boolean
          scheduled_hard_delete_at?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          account_deletion_token?: string | null
          active_family_id?: string | null
          created_at?: string
          deleted_at?: string | null
          enable_daily_reminder?: boolean
          expo_push_token?: string | null
          hard_delete_started_at?: string | null
          hard_delete_token?: string | null
          has_completed_onboarding?: boolean
          id?: string
          name?: string
          notification_time?: string | null
          notify_engagement?: boolean
          notify_new_memories?: boolean
          scheduled_hard_delete_at?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_profiles_active_family_id_fkey"
            columns: ["active_family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ai_usage_observability_gaps: {
        Row: {
          consumed_at: string | null
          family_id: string | null
          target_id: string | null
          target_kind: string | null
          usage_request_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_image_generation_requests_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      family_ai_costs_monthly: {
        Row: {
          calls: number | null
          estimated_cost_usd: number | null
          failed_calls: number | null
          family_id: string | null
          model: string | null
          month: string | null
          operation: string | null
          unpriced_calls: number | null
        }
        Insert: {
          calls?: number | null
          estimated_cost_usd?: number | null
          failed_calls?: number | null
          family_id?: string | null
          model?: string | null
          month?: string | null
          operation?: string | null
          unpriced_calls?: number | null
        }
        Update: {
          calls?: number | null
          estimated_cost_usd?: number | null
          failed_calls?: number | null
          family_id?: string | null
          model?: string | null
          month?: string | null
          operation?: string | null
          unpriced_calls?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_monthly_rollups_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      ai_usage_is_active: {
        Args: {
          p_settings: Database["public"]["Tables"]["ai_usage_settings"]["Row"]
        }
        Returns: boolean
      }
      ai_usage_limit_scope: {
        Args: {
          p_family_id: string
          p_intent: string
          p_now: string
          p_settings: Database["public"]["Tables"]["ai_usage_settings"]["Row"]
          p_target_id: string
          p_target_kind: string
        }
        Returns: string
      }
      ai_usage_reject: {
        Args: {
          p_actor_id: string
          p_epoch: number
          p_family_id: string
          p_now: string
          p_scope: string
          p_target_id: string
          p_target_kind: string
        }
        Returns: string
      }
      ai_usage_retry_after: {
        Args: { p_now: string; p_scope: string }
        Returns: string
      }
      authorize_memory_illustration_workflow_upload: {
        Args: { p_job_id: string; p_output_key: string }
        Returns: {
          authorized: boolean
          existing_lease: boolean
          upload_token: string
        }[]
      }
      authorize_portrait_generation_workflow_upload: {
        Args: { p_job_id: string; p_output_key: string }
        Returns: {
          authorized: boolean
          existing_lease: boolean
          upload_token: string
        }[]
      }
      begin_memory_illustration_usage: {
        Args: {
          p_actor_user_id: string
          p_memory_id: string
          p_request_id: string
          p_request_intent: string
        }
        Returns: {
          existing_job_id: string
          outcome: string
          preparation_deadline_at: string
          preparation_input_updated_at: string
          preparation_ordinal: number
          preparation_token: string
          request_id: string
          retry_after_iso: string
          scope: string
        }[]
      }
      begin_portrait_generation_usage: {
        Args: {
          p_actor_user_id: string
          p_portrait_version_id: string
          p_request_id: string
          p_request_intent: string
        }
        Returns: {
          existing_job_id: string
          outcome: string
          preparation_deadline_at: string
          preparation_input_updated_at: string
          preparation_ordinal: number
          preparation_token: string
          request_id: string
          retry_after_iso: string
          scope: string
        }[]
      }
      cancel_account_deletion: {
        Args: { p_owner_id: string }
        Returns: boolean
      }
      claim_account_hard_deletion: {
        Args: { p_hard_delete_token: string; p_owner_id: string }
        Returns: boolean
      }
      claim_ai_usage_alert_outbox: {
        Args: { p_id: string }
        Returns: {
          claim_token: string
          claimed: boolean
          payload: Json
        }[]
      }
      claim_content_report_email_alert: {
        Args: { p_report_id: string }
        Returns: {
          attempt_token: string
          report_id: string
        }[]
      }
      claim_family_deletion_fence: {
        Args: { p_delete_token: string; p_family_id: string }
        Returns: boolean
      }
      claim_family_member_deletion_fence: {
        Args: { p_delete_token: string; p_family_member_id: string }
        Returns: boolean
      }
      claim_family_member_portrait_deletion: {
        Args: {
          actor_user_id: string
          delete_token: string
          target_version_id: string
        }
        Returns: {
          created_at: string
          date_source: string
          deletion_started_at: string | null
          deletion_token: string | null
          family_id: string
          family_member_id: string
          generation_output_key: string | null
          generation_started_at: string | null
          generation_token: string | null
          id: string
          illustrated_profile_key: string | null
          illustrated_profile_status: string
          profile_picture_key: string
          reference_date: string | null
          updated_at: string
          usage_limit_epoch: number | null
          usage_limit_retry_after: string | null
          usage_limit_scope: string | null
          usage_preparation_deadline_at: string | null
          usage_preparation_input_updated_at: string | null
          usage_preparation_ordinal: number | null
          usage_preparation_request_id: string | null
          usage_preparation_token: string | null
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_member_portrait_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      claim_family_member_portrait_generation: {
        Args: {
          actor_user_id: string
          attempt_key: string
          attempt_token: string
          target_version_id: string
        }
        Returns: {
          created_at: string
          date_source: string
          deletion_started_at: string | null
          deletion_token: string | null
          family_id: string
          family_member_id: string
          generation_output_key: string | null
          generation_started_at: string | null
          generation_token: string | null
          id: string
          illustrated_profile_key: string | null
          illustrated_profile_status: string
          profile_picture_key: string
          reference_date: string | null
          updated_at: string
          usage_limit_epoch: number | null
          usage_limit_retry_after: string | null
          usage_limit_scope: string | null
          usage_preparation_deadline_at: string | null
          usage_preparation_input_updated_at: string | null
          usage_preparation_ordinal: number | null
          usage_preparation_request_id: string | null
          usage_preparation_token: string | null
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_member_portrait_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      claim_memory_illustration_workflow_generation: {
        Args: {
          p_actor_user_id: string
          p_attempt_id: string
          p_expected_content: string
          p_expected_emotion: string
          p_expected_generation_id: string
          p_expected_illustration_key: string
          p_expected_memory_date: string
          p_expected_memory_type: string
          p_expected_prior_attempt_id: string
          p_expected_status: string
          p_memory_id: string
        }
        Returns: boolean
      }
      create_content_report: {
        Args: {
          p_note?: string
          p_reason: string
          p_target_id: string
          p_target_type: string
          p_target_version_id?: string
        }
        Returns: string
      }
      create_family: {
        Args: { name: string }
        Returns: {
          account_deletion_token: string | null
          created_at: string
          deleted_at: string | null
          deletion_fence_started_at: string | null
          deletion_fence_token: string | null
          id: string
          illustration_style: string
          name: string
          owner_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "families"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_family_invite: {
        Args: { fam: string; invite_role: string }
        Returns: {
          code: string
          created_at: string
          expires_at: string
          family_id: string
          id: string
          invited_by: string
          redeemed_at: string | null
          redeemed_by: string | null
          resolved_at: string | null
          resolved_by: string | null
          role: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "family_invites"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_family_member_portrait_version: {
        Args: {
          portrait_date_source: string
          portrait_reference_date: string
          source_profile_picture_key: string
          target_family_member_id: string
          version_id: string
        }
        Returns: {
          created_at: string
          date_source: string
          deletion_started_at: string | null
          deletion_token: string | null
          family_id: string
          family_member_id: string
          generation_output_key: string | null
          generation_started_at: string | null
          generation_token: string | null
          id: string
          illustrated_profile_key: string | null
          illustrated_profile_status: string
          profile_picture_key: string
          reference_date: string | null
          updated_at: string
          usage_limit_epoch: number | null
          usage_limit_retry_after: string | null
          usage_limit_scope: string | null
          usage_preparation_deadline_at: string | null
          usage_preparation_input_updated_at: string | null
          usage_preparation_ordinal: number | null
          usage_preparation_request_id: string | null
          usage_preparation_token: string | null
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_member_portrait_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_user_local_date: { Args: never; Returns: string }
      delete_family: {
        Args: { fam: string }
        Returns: {
          account_deletion_token: string | null
          created_at: string
          deleted_at: string | null
          deletion_fence_started_at: string | null
          deletion_fence_token: string | null
          id: string
          illustration_style: string
          name: string
          owner_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "families"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      enqueue_ai_usage_alerts: {
        Args: { p_environment_id: string; p_now?: string }
        Returns: {
          attempts: number
          claim_started_at: string | null
          claim_token: string | null
          created_at: string
          environment_id: string
          family_id: string | null
          id: string
          idempotency_key: string
          kind: string
          payload: Json
          period_start: string
          policy_version: number
          sent_at: string | null
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "ai_usage_alert_outbox"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      fail_family_member_portrait_generation: {
        Args: { attempt_token: string; target_version_id: string }
        Returns: {
          created_at: string
          date_source: string
          deletion_started_at: string | null
          deletion_token: string | null
          family_id: string
          family_member_id: string
          generation_output_key: string | null
          generation_started_at: string | null
          generation_token: string | null
          id: string
          illustrated_profile_key: string | null
          illustrated_profile_status: string
          profile_picture_key: string
          reference_date: string | null
          updated_at: string
          usage_limit_epoch: number | null
          usage_limit_retry_after: string | null
          usage_limit_scope: string | null
          usage_preparation_deadline_at: string | null
          usage_preparation_input_updated_at: string | null
          usage_preparation_ordinal: number | null
          usage_preparation_request_id: string | null
          usage_preparation_token: string | null
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_member_portrait_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      fail_memory_illustration_workflow_job: {
        Args: { p_error_code: string; p_job_id: string }
        Returns: {
          failed: boolean
          output_key: string
        }[]
      }
      fail_portrait_generation_workflow_job: {
        Args: { p_error_code: string; p_job_id: string }
        Returns: {
          output_key: string
          terminal_status: string
        }[]
      }
      finish_family_member_portrait_deletion: {
        Args: { delete_token: string; target_version_id: string }
        Returns: boolean
      }
      finish_family_member_portrait_generation: {
        Args: {
          attempt_token: string
          generated_portrait_key: string
          target_version_id: string
        }
        Returns: {
          created_at: string
          date_source: string
          deletion_started_at: string | null
          deletion_token: string | null
          family_id: string
          family_member_id: string
          generation_output_key: string | null
          generation_started_at: string | null
          generation_token: string | null
          id: string
          illustrated_profile_key: string | null
          illustrated_profile_status: string
          profile_picture_key: string
          reference_date: string | null
          updated_at: string
          usage_limit_epoch: number | null
          usage_limit_retry_after: string | null
          usage_limit_scope: string | null
          usage_preparation_deadline_at: string | null
          usage_preparation_input_updated_at: string | null
          usage_preparation_ordinal: number | null
          usage_preparation_request_id: string | null
          usage_preparation_token: string | null
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_member_portrait_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finish_owned_family_deletion_fences: {
        Args: { p_fences: Json; p_owner_id: string }
        Returns: boolean
      }
      get_content_report_email_alert_redrive_candidates: {
        Args: { p_limit?: number }
        Returns: {
          report_id: string
        }[]
      }
      get_family_member_profiles: {
        Args: { fam: string }
        Returns: {
          created_at: string
          is_active_member: boolean
          membership_id: string
          name: string
          role: string
          user_id: string
        }[]
      }
      get_invite_redeemer: {
        Args: { invite_id: string }
        Returns: {
          email: string
          name: string
        }[]
      }
      get_memory_engagement: {
        Args: { memory_ids: string[] }
        Returns: {
          comment_count: number
          like_count: number
          liked_by_me: boolean
          memory_id: string
        }[]
      }
      get_my_ai_usage_limit_notices: {
        Args: never
        Returns: {
          actor_user_id: string
          created_at: string
          dismissed_at: string | null
          family_id: string
          id: string
          quota_policy_epoch: number
          retry_after: string
          scope: string
          target_id: string
          target_kind: string
        }[]
        SetofOptions: {
          from: "*"
          to: "ai_usage_limit_notices"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_my_open_content_reports: {
        Args: { p_family_id: string }
        Returns: {
          created_at: string
          family_id: string
          id: string
          status: string
          target_id: string
          target_type: string
          target_version_id: string
        }[]
      }
      get_my_redeemed_invite_status: {
        Args: never
        Returns: {
          family_name: string
          family_unavailable: boolean
          invite_id: string
          status: string
        }[]
      }
      has_family_role: {
        Args: { fam: string; roles: string[] }
        Returns: boolean
      }
      is_family_member: { Args: { fam: string }; Returns: boolean }
      mark_ai_usage_alert_outbox_delivery_unknown: {
        Args: { p_id: string; p_token: string }
        Returns: boolean
      }
      mark_ai_usage_alert_outbox_sent: {
        Args: { p_id: string; p_token: string }
        Returns: boolean
      }
      mark_content_report_email_alert_sent: {
        Args: { p_attempt_token: string; p_report_id: string }
        Returns: boolean
      }
      promote_ai_image_preparation:
        | {
            Args: {
              p_job_id?: string
              p_preparation_token: string
              p_request_id: string
            }
            Returns: boolean
          }
        | {
            Args: {
              p_job_id?: string
              p_preparation_input_updated_at: string
              p_preparation_ordinal: number
              p_preparation_token: string
              p_request_id: string
            }
            Returns: boolean
          }
      publish_memory_illustration_workflow_job: {
        Args: { p_job_id: string; p_model: string }
        Returns: {
          already_published: boolean
          old_key: string
          published: boolean
        }[]
      }
      publish_portrait_generation_workflow_job: {
        Args: { p_job_id: string; p_model: string }
        Returns: {
          already_published: boolean
          old_key: string
          published: boolean
        }[]
      }
      purge_expired_ai_usage_data: {
        Args: { p_now?: string }
        Returns: {
          events_deleted: number
          notices_deleted: number
          outbox_deleted: number
          requests_deleted: number
          rollups_deleted: number
        }[]
      }
      reconcile_portrait_generation_workflow_job: {
        Args: { p_job_id: string; p_model: string }
        Returns: {
          already_published: boolean
          old_key: string
          published: boolean
        }[]
      }
      record_ai_memory_preparation_emotion: {
        Args: {
          p_emotion: string
          p_preparation_input_updated_at: string
          p_preparation_ordinal: number
          p_preparation_token: string
          p_request_id: string
        }
        Returns: boolean
      }
      record_ai_usage_event: {
        Args: {
          p_ai_call_id: string
          p_attempt_number: number
          p_audio_seconds: number
          p_billing_status: string
          p_cached_input_tokens: number
          p_cost_basis: string
          p_cost_is_complete: boolean
          p_estimated_cost_usd: number
          p_input_image_tokens: number
          p_input_text_tokens: number
          p_job_id: string
          p_job_kind: string
          p_model: string
          p_operation: string
          p_output_image_tokens: number
          p_output_text_tokens: number
          p_pricing_version: string
          p_provider: string
          p_provider_usage: Json
          p_success: boolean
          p_usage_request_id: string
        }
        Returns: boolean
      }
      record_ai_usage_event_detailed: {
        Args: {
          p_actor_user_id: string
          p_ai_call_id: string
          p_billing_status?: string
          p_cost_basis?: string
          p_cost_is_complete?: boolean
          p_estimated_cost_usd?: number
          p_family_id: string
          p_model: string
          p_operation: string
          p_pricing_version?: string
          p_provider_usage?: Json
          p_success: boolean
          p_usage_request_id: string
        }
        Returns: boolean
      }
      record_ai_usage_event_legacy: {
        Args: {
          p_ai_call_id: string
          p_billing_status: string
          p_model: string
          p_operation: string
          p_provider_usage: Json
          p_success: boolean
          p_usage_request_id: string
        }
        Returns: boolean
      }
      record_memory_illustration_workflow_upload_complete: {
        Args: { p_job_id: string; p_output_key: string; p_upload_token: string }
        Returns: boolean
      }
      record_portrait_generation_workflow_upload_complete: {
        Args: { p_job_id: string; p_output_key: string; p_upload_token: string }
        Returns: boolean
      }
      refresh_account_hard_deletion_claim: {
        Args: { p_hard_delete_token: string; p_owner_id: string }
        Returns: boolean
      }
      release_account_hard_deletion_claim: {
        Args: { p_hard_delete_token: string; p_owner_id: string }
        Returns: boolean
      }
      release_ai_image_preparation:
        | {
            Args: {
              p_preparation_input_updated_at: string
              p_preparation_ordinal: number
              p_preparation_token: string
              p_reason: string
              p_request_id: string
            }
            Returns: boolean
          }
        | {
            Args: {
              p_preparation_token: string
              p_reason?: string
              p_request_id: string
            }
            Returns: boolean
          }
      release_ai_usage_alert_outbox: {
        Args: { p_id: string; p_token: string }
        Returns: boolean
      }
      release_content_report_email_alert: {
        Args: { p_attempt_token: string; p_report_id: string }
        Returns: boolean
      }
      release_family_deletion_fence: {
        Args: { p_delete_token: string; p_family_id: string }
        Returns: boolean
      }
      release_family_member_deletion_fence: {
        Args: { p_delete_token: string; p_family_member_id: string }
        Returns: boolean
      }
      replace_memory_media_assets: {
        Args: { assets: Json; target_memory_id: string }
        Returns: undefined
      }
      reserve_ai_image_provider_attempt_v2:
        | {
            Args: {
              p_attempt_number: number
              p_job_id: string
              p_job_kind: string
              p_provider: string
              p_request_id: string
            }
            Returns: {
              outcome: string
              protocol_version: number
              retry_after_iso: string
              scope: string
            }[]
          }
        | {
            Args: {
              p_attempt_number: number
              p_provider: string
              p_request_id: string
            }
            Returns: {
              outcome: string
              protocol_version: number
              retry_after_iso: string
              scope: string
            }[]
          }
      reserve_legacy_ai_image_provider_attempt_v2: {
        Args: {
          p_attempt_number: number
          p_preparation_input_updated_at: string
          p_preparation_ordinal: number
          p_preparation_token: string
          p_provider: string
          p_request_id: string
          p_target_id: string
          p_target_kind: string
        }
        Returns: {
          outcome: string
          protocol_version: number
          retry_after_iso: string
          scope: string
        }[]
      }
      reserve_memory_illustration_provider_attempt: {
        Args: { p_attempt_number: number; p_job_id: string; p_provider: string }
        Returns: boolean
      }
      reserve_portrait_generation_provider_attempt: {
        Args: { p_attempt_number: number; p_job_id: string; p_provider: string }
        Returns: boolean
      }
      schedule_account_deletion: {
        Args: {
          p_operation_token: string
          p_owner_id: string
          p_scheduled_hard_delete_at: string
        }
        Returns: string
      }
      set_family_account_block: {
        Args: {
          p_block_id?: string
          p_membership_id?: string
          p_should_block: boolean
        }
        Returns: {
          blocked_membership_id: string | null
          blocked_user_id: string
          blocker_user_id: string
          created_at: string
          family_id: string
          id: string
        }
        SetofOptions: {
          from: "*"
          to: "blocked_family_accounts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_memory_like: {
        Args: { should_like: boolean; target_memory_id: string }
        Returns: {
          changed: boolean
          like_count: number
          liked: boolean
        }[]
      }
      supersede_memory_illustration_workflow_jobs: {
        Args: { p_current_attempt_id: string; p_memory_id: string }
        Returns: {
          output_key: string
          superseded: boolean
        }[]
      }
      supersede_portrait_generation_workflow_jobs: {
        Args: { p_current_attempt_id: string; p_portrait_version_id: string }
        Returns: number
      }
      update_family_member_portrait_version_date: {
        Args: { portrait_reference_date: string; target_version_id: string }
        Returns: {
          created_at: string
          date_source: string
          deletion_started_at: string | null
          deletion_token: string | null
          family_id: string
          family_member_id: string
          generation_output_key: string | null
          generation_started_at: string | null
          generation_token: string | null
          id: string
          illustrated_profile_key: string | null
          illustrated_profile_status: string
          profile_picture_key: string
          reference_date: string | null
          updated_at: string
          usage_limit_epoch: number | null
          usage_limit_retry_after: string | null
          usage_limit_scope: string | null
          usage_preparation_deadline_at: string | null
          usage_preparation_input_updated_at: string | null
          usage_preparation_ordinal: number | null
          usage_preparation_request_id: string | null
          usage_preparation_token: string | null
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_member_portrait_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
