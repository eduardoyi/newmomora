export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
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
          created_at: string
          deleted_at: string | null
          id: string
          illustration_style: string
          name: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          illustration_style?: string
          name: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
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
          user_id?: string | null
        }
        Relationships: [
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
          illustration_key: string | null
          illustration_prompt: string | null
          illustration_status: string
          link_previews: Json
          media_content_type: string | null
          media_key: string | null
          memory_date: string
          memory_type: string
          updated_at: string
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
          illustration_key?: string | null
          illustration_prompt?: string | null
          illustration_status?: string
          link_previews?: Json
          media_content_type?: string | null
          media_key?: string | null
          memory_date?: string
          memory_type?: string
          updated_at?: string
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
          illustration_key?: string | null
          illustration_prompt?: string | null
          illustration_status?: string
          link_previews?: Json
          media_content_type?: string | null
          media_key?: string | null
          memory_date?: string
          memory_type?: string
          updated_at?: string
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
      user_profiles: {
        Row: {
          active_family_id: string | null
          created_at: string
          deleted_at: string | null
          enable_daily_reminder: boolean
          expo_push_token: string | null
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
          active_family_id?: string | null
          created_at?: string
          deleted_at?: string | null
          enable_daily_reminder?: boolean
          expo_push_token?: string | null
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
          active_family_id?: string | null
          created_at?: string
          deleted_at?: string | null
          enable_daily_reminder?: boolean
          expo_push_token?: string | null
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
      [_ in never]: never
    }
    Functions: {
      claim_content_report_email_alert: {
        Args: { p_report_id: string }
        Returns: {
          attempt_token: string
          report_id: string
        }[]
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
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_member_portrait_versions"
          isOneToOne: true
          isSetofReturn: false
        }
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
          created_at: string
          deleted_at: string | null
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
          created_at: string
          deleted_at: string | null
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
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_member_portrait_versions"
          isOneToOne: true
          isSetofReturn: false
        }
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
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "family_member_portrait_versions"
          isOneToOne: true
          isSetofReturn: false
        }
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
      mark_content_report_email_alert_sent: {
        Args: { p_attempt_token: string; p_report_id: string }
        Returns: boolean
      }
      release_content_report_email_alert: {
        Args: { p_attempt_token: string; p_report_id: string }
        Returns: boolean
      }
      replace_memory_media_assets: {
        Args: { assets: Json; target_memory_id: string }
        Returns: undefined
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
