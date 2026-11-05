export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_concepts: {
        Row: {
          auto_concept: string
          auto_endings: string[]
          auto_hooks: string[]
          auto_role_focus: string | null
          auto_tone: string
          auto_video_style: string
          auto_voice_id: string | null
          shoot_voice_id: string | null
          organization_id: string
          shoot_concept: string
          shoot_edit_params: Json | null
          shoot_edit_style: string
          shoot_endings: string[]
          shoot_hooks: string[]
          shoot_role_focus: string | null
          shoot_tone: string
          shoot_voice_mode: string
          social_account_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          auto_concept?: string
          auto_endings?: string[]
          auto_hooks?: string[]
          auto_role_focus?: string | null
          auto_tone?: string
          auto_video_style?: string
          auto_voice_id?: string | null
          shoot_voice_id?: string | null
          organization_id: string
          shoot_concept?: string
          shoot_edit_params?: Json | null
          shoot_edit_style?: string
          shoot_endings?: string[]
          shoot_hooks?: string[]
          shoot_role_focus?: string | null
          shoot_tone?: string
          shoot_voice_mode?: string
          social_account_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          auto_concept?: string
          auto_endings?: string[]
          auto_hooks?: string[]
          auto_role_focus?: string | null
          auto_tone?: string
          auto_video_style?: string
          auto_voice_id?: string | null
          shoot_voice_id?: string | null
          organization_id?: string
          shoot_concept?: string
          shoot_edit_params?: Json | null
          shoot_edit_style?: string
          shoot_endings?: string[]
          shoot_hooks?: string[]
          shoot_role_focus?: string | null
          shoot_tone?: string
          shoot_voice_mode?: string
          social_account_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      account_daily: {
        Row: {
          accounts_engaged: number | null
          collected_at: string
          day: string
          followers_count: number | null
          follows_count: number | null
          media_count: number | null
          organization_id: string
          raw: Json
          reach: number | null
          social_account_id: string
          total_interactions: number | null
          views: number | null
        }
        Insert: {
          accounts_engaged?: number | null
          collected_at?: string
          day: string
          followers_count?: number | null
          follows_count?: number | null
          media_count?: number | null
          organization_id: string
          raw?: Json
          reach?: number | null
          social_account_id: string
          total_interactions?: number | null
          views?: number | null
        }
        Update: {
          accounts_engaged?: number | null
          collected_at?: string
          day?: string
          followers_count?: number | null
          follows_count?: number | null
          media_count?: number | null
          organization_id?: string
          raw?: Json
          reach?: number | null
          social_account_id?: string
          total_interactions?: number | null
          views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "account_daily_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_daily_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      account_groups: {
        Row: {
          color: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_groups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      account_story_days: {
        Row: {
          checked_at: string
          day: string
          organization_id: string
          social_account_id: string
          stories_count: number
        }
        Insert: {
          checked_at?: string
          day: string
          organization_id: string
          social_account_id: string
          stories_count?: number
        }
        Update: {
          checked_at?: string
          day?: string
          organization_id?: string
          social_account_id?: string
          stories_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "account_story_days_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_story_days_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_feedback: {
        Row: {
          agent: string
          applied_version: number | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          evidence: Json
          id: string
          organization_id: string
          proposed_body: string
          reject_reason: string | null
          status: string
          title: string
        }
        Insert: {
          agent: string
          applied_version?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          evidence?: Json
          id?: string
          organization_id: string
          proposed_body: string
          reject_reason?: string | null
          status?: string
          title: string
        }
        Update: {
          agent?: string
          applied_version?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          evidence?: Json
          id?: string
          organization_id?: string
          proposed_body?: string
          reject_reason?: string | null
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_feedback_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_feedback_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_playbooks: {
        Row: {
          agent: string
          body: string
          created_at: string
          created_by: string | null
          feedback_id: string | null
          id: string
          note: string | null
          organization_id: string
          source: string
          version: number
        }
        Insert: {
          agent: string
          body: string
          created_at?: string
          created_by?: string | null
          feedback_id?: string | null
          id?: string
          note?: string | null
          organization_id: string
          source: string
          version: number
        }
        Update: {
          agent?: string
          body?: string
          created_at?: string
          created_by?: string | null
          feedback_id?: string | null
          id?: string
          note?: string | null
          organization_id?: string
          source?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_playbooks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_playbooks_feedback_id_fkey"
            columns: ["feedback_id"]
            isOneToOne: false
            referencedRelation: "agent_feedback"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_playbooks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          agent: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json
          model: string | null
          organization_id: string | null
          output: Json | null
          plan_id: string | null
          playbook_version: number | null
          skill_calls: Json
          started_at: string
          status: string
          tokens_input: number | null
          tokens_output: number | null
        }
        Insert: {
          agent: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json
          model?: string | null
          organization_id?: string | null
          output?: Json | null
          plan_id?: string | null
          playbook_version?: number | null
          skill_calls?: Json
          started_at?: string
          status?: string
          tokens_input?: number | null
          tokens_output?: number | null
        }
        Update: {
          agent?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json
          model?: string | null
          organization_id?: string | null
          output?: Json | null
          plan_id?: string | null
          playbook_version?: number | null
          skill_calls?: Json
          started_at?: string
          status?: string
          tokens_input?: number | null
          tokens_output?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "content_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_settings: {
        Row: {
          agent: string
          approval_mode: string
          organization_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          agent: string
          approval_mode?: string
          organization_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          agent?: string
          approval_mode?: string
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      benchmark_analyses: {
        Row: {
          created_at: string
          hits_count: number
          id: string
          model: string | null
          normal_count: number
          organization_id: string
          social_account_id: string
          stats: Json
          summary: Json
          tokens_input: number | null
          tokens_output: number | null
          video_count: number
        }
        Insert: {
          created_at?: string
          hits_count?: number
          id?: string
          model?: string | null
          normal_count?: number
          organization_id: string
          social_account_id: string
          stats?: Json
          summary?: Json
          tokens_input?: number | null
          tokens_output?: number | null
          video_count?: number
        }
        Update: {
          created_at?: string
          hits_count?: number
          id?: string
          model?: string | null
          normal_count?: number
          organization_id?: string
          social_account_id?: string
          stats?: Json
          summary?: Json
          tokens_input?: number | null
          tokens_output?: number | null
          video_count?: number
        }
        Relationships: []
      }
      benchmark_accounts: {
        Row: {
          biography: string | null
          created_at: string
          display_name: string | null
          error: string | null
          followers_count: number | null
          id: string
          last_collected_at: string | null
          last_post_at: string | null
          media_count: number | null
          median_views: number | null
          organization_id: string
          own_account_id: string | null
          reels_30d: number | null
          reels_sampled: number | null
          status: string
          username: string
        }
        Insert: {
          biography?: string | null
          created_at?: string
          display_name?: string | null
          error?: string | null
          followers_count?: number | null
          id?: string
          last_collected_at?: string | null
          last_post_at?: string | null
          media_count?: number | null
          median_views?: number | null
          organization_id: string
          own_account_id?: string | null
          reels_30d?: number | null
          reels_sampled?: number | null
          status?: string
          username: string
        }
        Update: {
          biography?: string | null
          created_at?: string
          display_name?: string | null
          error?: string | null
          followers_count?: number | null
          id?: string
          last_collected_at?: string | null
          last_post_at?: string | null
          media_count?: number | null
          median_views?: number | null
          organization_id?: string
          own_account_id?: string | null
          reels_30d?: number | null
          reels_sampled?: number | null
          status?: string
          username?: string
        }
        Relationships: []
      }
      benchmark_links: {
        Row: {
          benchmark_account_id: string
          created_at: string
          created_by: string | null
          group_type: string
          id: string
          organization_id: string
          reason: string | null
          social_account_id: string
          source: string
        }
        Insert: {
          benchmark_account_id: string
          created_at?: string
          created_by?: string | null
          group_type?: string
          id?: string
          organization_id: string
          reason?: string | null
          social_account_id: string
          source?: string
        }
        Update: {
          benchmark_account_id?: string
          created_at?: string
          created_by?: string | null
          group_type?: string
          id?: string
          organization_id?: string
          reason?: string | null
          social_account_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "benchmark_links_benchmark_account_id_fkey"
            columns: ["benchmark_account_id"]
            isOneToOne: false
            referencedRelation: "benchmark_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      benchmark_posts: {
        Row: {
          ad_suspected: boolean
          benchmark_account_id: string
          caption: string | null
          comments_count: number | null
          first_seen_at: string
          formula: string | null
          hook_score: number | null
          id: string
          like_count: number | null
          media_product_type: string | null
          multiple: number | null
          organization_id: string
          permalink: string | null
          platform_media_id: string
          posted_at: string | null
          reposts_count: number | null
          style: Json | null
          style_analyzed_at: string | null
          style_source: string | null
          thumbnail_url: string | null
          updated_at: string
          video_url: string | null
          view_count: number | null
        }
        Insert: {
          ad_suspected?: boolean
          benchmark_account_id: string
          caption?: string | null
          comments_count?: number | null
          first_seen_at?: string
          formula?: string | null
          hook_score?: number | null
          id?: string
          like_count?: number | null
          media_product_type?: string | null
          multiple?: number | null
          organization_id: string
          permalink?: string | null
          platform_media_id: string
          posted_at?: string | null
          reposts_count?: number | null
          style?: Json | null
          style_analyzed_at?: string | null
          style_source?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          video_url?: string | null
          view_count?: number | null
        }
        Update: {
          ad_suspected?: boolean
          benchmark_account_id?: string
          caption?: string | null
          comments_count?: number | null
          first_seen_at?: string
          formula?: string | null
          hook_score?: number | null
          id?: string
          like_count?: number | null
          media_product_type?: string | null
          multiple?: number | null
          organization_id?: string
          permalink?: string | null
          platform_media_id?: string
          posted_at?: string | null
          reposts_count?: number | null
          style?: Json | null
          style_analyzed_at?: string | null
          style_source?: string | null
          thumbnail_url?: string | null
          updated_at?: string
          video_url?: string | null
          view_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "benchmark_posts_benchmark_account_id_fkey"
            columns: ["benchmark_account_id"]
            isOneToOne: false
            referencedRelation: "benchmark_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      caption_presets: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          instructions: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          instructions: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          instructions?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "caption_presets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "caption_presets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      content_plans: {
        Row: {
          posted_at: string | null
          posted_by: string | null
          posted_media_id: string | null
          posted_permalink: string | null
          check_result: Json | null
          confirmed_at: string | null
          confirmed_by: string | null
          content_id: string | null
          created_at: string
          error: string | null
          human_brief: string | null
          id: string
          note: string | null
          organization_id: string
          product_changed: boolean
          product_id: string | null
          proposal: Json
          publish_job_id: string | null
          script: Json | null
          slot_date: string | null
          slot_time: string | null
          social_account_id: string
          status: string
          track: string
          updated_at: string
          video: Json | null
          warnings_ack: Json
          warnings_ack_at: string | null
          warnings_ack_by: string | null
        }
        Insert: {
          posted_at?: string | null
          posted_by?: string | null
          posted_media_id?: string | null
          posted_permalink?: string | null
          check_result?: Json | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          content_id?: string | null
          created_at?: string
          error?: string | null
          human_brief?: string | null
          id?: string
          note?: string | null
          organization_id: string
          product_changed?: boolean
          product_id?: string | null
          proposal?: Json
          publish_job_id?: string | null
          script?: Json | null
          slot_date?: string | null
          slot_time?: string | null
          social_account_id: string
          status?: string
          track: string
          updated_at?: string
          video?: Json | null
          warnings_ack?: Json
          warnings_ack_at?: string | null
          warnings_ack_by?: string | null
        }
        Update: {
          posted_at?: string | null
          posted_by?: string | null
          posted_media_id?: string | null
          posted_permalink?: string | null
          check_result?: Json | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          content_id?: string | null
          created_at?: string
          error?: string | null
          human_brief?: string | null
          id?: string
          note?: string | null
          organization_id?: string
          product_changed?: boolean
          product_id?: string | null
          proposal?: Json
          publish_job_id?: string | null
          script?: Json | null
          slot_date?: string | null
          slot_time?: string | null
          social_account_id?: string
          status?: string
          track?: string
          updated_at?: string
          video?: Json | null
          warnings_ack?: Json
          warnings_ack_at?: string | null
          warnings_ack_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_plans_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_plans_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_plans_publish_job_id_fkey"
            columns: ["publish_job_id"]
            isOneToOne: false
            referencedRelation: "publish_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_plans_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "contents"
            referencedColumns: ["id"]
          },
        ]
      }
      content_rules: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          id: string
          match_type: string
          phrase: string
          reason: string | null
          rule_type: string
          scope: string
          suggestion: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          match_type?: string
          phrase: string
          reason?: string | null
          rule_type?: string
          scope?: string
          suggestion?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          match_type?: string
          phrase?: string
          reason?: string | null
          rule_type?: string
          scope?: string
          suggestion?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "content_rules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      contents: {
        Row: {
          ai_analyzed_at: string | null
          ai_captions: Json | null
          created_at: string
          created_by: string | null
          draft_saved_at: string | null
          draft_state: Json | null
          id: string
          internal_title: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          media_urls: string[]
          metadata: Json
          organization_id: string
          title: string | null
          updated_at: string
        }
        Insert: {
          ai_analyzed_at?: string | null
          ai_captions?: Json | null
          created_at?: string
          created_by?: string | null
          draft_saved_at?: string | null
          draft_state?: Json | null
          id?: string
          internal_title?: string | null
          media_type: Database["public"]["Enums"]["media_type"]
          media_urls: string[]
          metadata?: Json
          organization_id: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          ai_analyzed_at?: string | null
          ai_captions?: Json | null
          created_at?: string
          created_by?: string | null
          draft_saved_at?: string | null
          draft_state?: Json | null
          id?: string
          internal_title?: string | null
          media_type?: Database["public"]["Enums"]["media_type"]
          media_urls?: string[]
          metadata?: Json
          organization_id?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contents_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      generated_visuals: {
        Row: {
          cost_usd: number
          created_at: string
          id: string
          input_tokens: number
          key: string
          last_used_at: string | null
          model: string
          output_tokens: number
          path: string
          prompt: string
          quality: string | null
          subject: string
          use_count: number
        }
        Insert: {
          cost_usd?: number
          created_at?: string
          id?: string
          input_tokens?: number
          key: string
          last_used_at?: string | null
          model: string
          output_tokens?: number
          path: string
          prompt: string
          quality?: string | null
          subject: string
          use_count?: number
        }
        Update: {
          cost_usd?: number
          created_at?: string
          id?: string
          input_tokens?: number
          key?: string
          last_used_at?: string | null
          model?: string
          output_tokens?: number
          path?: string
          prompt?: string
          quality?: string | null
          subject?: string
          use_count?: number
        }
        Relationships: []
      }
      invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          expires_at: string
          id: string
          invited_by: string | null
          invited_email: string
          organization_id: string
          role: Database["public"]["Enums"]["user_role"]
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          invited_email: string
          organization_id: string
          role?: Database["public"]["Enums"]["user_role"]
          token?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          invited_email?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["user_role"]
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      post_analyses: {
        Row: {
          actions: Json
          created_at: string
          findings: Json
          headline: string | null
          id: string
          model: string | null
          organization_id: string
          reels_count: number
          social_account_id: string
          stats: Json
          tokens_input: number | null
          tokens_output: number | null
        }
        Insert: {
          actions?: Json
          created_at?: string
          findings?: Json
          headline?: string | null
          id?: string
          model?: string | null
          organization_id: string
          reels_count?: number
          social_account_id: string
          stats?: Json
          tokens_input?: number | null
          tokens_output?: number | null
        }
        Update: {
          actions?: Json
          created_at?: string
          findings?: Json
          headline?: string | null
          id?: string
          model?: string | null
          organization_id?: string
          reels_count?: number
          social_account_id?: string
          stats?: Json
          tokens_input?: number | null
          tokens_output?: number | null
        }
        Relationships: []
      }
      post_history_sync: {
        Row: {
          all_listed_at: string | null
          listed_at: string | null
          media_listed: number | null
          organization_id: string
          reels_listed: number | null
          social_account_id: string
          updated_at: string
        }
        Insert: {
          all_listed_at?: string | null
          listed_at?: string | null
          media_listed?: number | null
          organization_id: string
          reels_listed?: number | null
          social_account_id: string
          updated_at?: string
        }
        Update: {
          all_listed_at?: string | null
          listed_at?: string | null
          media_listed?: number | null
          organization_id?: string
          reels_listed?: number | null
          social_account_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      post_metrics: {
        Row: {
          avg_watch_time_ms: number | null
          collected_at: string
          collected_on: string
          comments: number | null
          likes: number | null
          post_id: string
          raw: Json
          reach: number | null
          saved: number | null
          shares: number | null
          total_interactions: number | null
          total_watch_time_ms: number | null
          views: number | null
        }
        Insert: {
          avg_watch_time_ms?: number | null
          collected_at?: string
          collected_on: string
          comments?: number | null
          likes?: number | null
          post_id: string
          raw?: Json
          reach?: number | null
          saved?: number | null
          shares?: number | null
          total_interactions?: number | null
          total_watch_time_ms?: number | null
          views?: number | null
        }
        Update: {
          avg_watch_time_ms?: number | null
          collected_at?: string
          collected_on?: string
          comments?: number | null
          likes?: number | null
          post_id?: string
          raw?: Json
          reach?: number | null
          saved?: number | null
          shares?: number | null
          total_interactions?: number | null
          total_watch_time_ms?: number | null
          views?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "post_metrics_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      product_analyses: {
        Row: {
          analyzed_at: string
          approved_at: string | null
          approved_by: string | null
          claims: Json
          edited: boolean
          functional_claims: string[]
          health_functional: boolean | null
          kind: string
          model: string | null
          product_id: string
          rejected_claims: Json
          source_hash: string
          summary: Json
          uncertainties: string[]
        }
        Insert: {
          analyzed_at?: string
          approved_at?: string | null
          approved_by?: string | null
          claims?: Json
          edited?: boolean
          functional_claims?: string[]
          health_functional?: boolean | null
          kind: string
          model?: string | null
          product_id: string
          rejected_claims?: Json
          source_hash: string
          summary?: Json
          uncertainties?: string[]
        }
        Update: {
          analyzed_at?: string
          approved_at?: string | null
          approved_by?: string | null
          claims?: Json
          edited?: boolean
          functional_claims?: string[]
          health_functional?: boolean | null
          kind?: string
          model?: string | null
          product_id?: string
          rejected_claims?: Json
          source_hash?: string
          summary?: Json
          uncertainties?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "product_analyses_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_analyses_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: true
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_claim_approvals: {
        Row: {
          approved_at: string
          approved_by: string | null
          claim: string
          id: string
          product_id: string
          source: string
        }
        Insert: {
          approved_at?: string
          approved_by?: string | null
          claim: string
          id?: string
          product_id: string
          source?: string
        }
        Update: {
          approved_at?: string
          approved_by?: string | null
          claim?: string
          id?: string
          product_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_claim_approvals_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_claim_approvals_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_image_extracts: {
        Row: {
          analyzed_at: string
          data: Json
          height: number | null
          image_index: number
          image_url: string
          model: string | null
          part_count: number
          product_id: string
          text: string
          uncertainties: string[]
          width: number | null
        }
        Insert: {
          analyzed_at?: string
          data?: Json
          height?: number | null
          image_index: number
          image_url: string
          model?: string | null
          part_count?: number
          product_id: string
          text?: string
          uncertainties?: string[]
          width?: number | null
        }
        Update: {
          analyzed_at?: string
          data?: Json
          height?: number | null
          image_index?: number
          image_url?: string
          model?: string | null
          part_count?: number
          product_id?: string
          text?: string
          uncertainties?: string[]
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "product_image_extracts_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          analysis_attempts: number
          analysis_error: string | null
          analysis_locked_until: string | null
          analysis_note: string | null
          analysis_next_at: string
          analysis_state: string
          category_id: number | null
          category_name: string | null
          detail_image_urls: string[]
          excluded: boolean
          first_seen_at: string
          id: string
          kind: string | null
          last_seen_at: string
          name: string
          price: number | null
          product_status: string | null
          raw: Json
          represent_image_url: string | null
          shop_code: string
          shop_product_id: number
          source_hash: string
          source_updated_at: string | null
          stock_status: string
          summary_title: string | null
          updated_at: string
          url: string
        }
        Insert: {
          analysis_attempts?: number
          analysis_error?: string | null
          analysis_locked_until?: string | null
          analysis_note?: string | null
          analysis_next_at?: string
          analysis_state?: string
          category_id?: number | null
          category_name?: string | null
          detail_image_urls?: string[]
          excluded?: boolean
          first_seen_at?: string
          id?: string
          kind?: string | null
          last_seen_at?: string
          name: string
          price?: number | null
          product_status?: string | null
          raw?: Json
          represent_image_url?: string | null
          shop_code: string
          shop_product_id: number
          source_hash: string
          source_updated_at?: string | null
          stock_status?: string
          summary_title?: string | null
          updated_at?: string
          url: string
        }
        Update: {
          analysis_attempts?: number
          analysis_error?: string | null
          analysis_locked_until?: string | null
          analysis_note?: string | null
          analysis_next_at?: string
          analysis_state?: string
          category_id?: number | null
          category_name?: string | null
          detail_image_urls?: string[]
          excluded?: boolean
          first_seen_at?: string
          id?: string
          kind?: string | null
          last_seen_at?: string
          name?: string
          price?: number | null
          product_status?: string | null
          raw?: Json
          represent_image_url?: string | null
          shop_code?: string
          shop_product_id?: number
          source_hash?: string
          source_updated_at?: string | null
          stock_status?: string
          summary_title?: string | null
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_shop_code_fkey"
            columns: ["shop_code"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["code"]
          },
        ]
      }
      profile_reviews: {
        Row: {
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          items: Json | null
          manual_input: Json
          model: string | null
          organization_id: string
          requested_by: string | null
          rescore: number | null
          rewrites: Json | null
          snapshot: Json | null
          social_account_id: string
          started_at: string | null
          status: string
          summary: string | null
          tokens_input: number | null
          tokens_output: number | null
          total_score: number | null
        }
        Insert: {
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          items?: Json | null
          manual_input?: Json
          model?: string | null
          organization_id: string
          requested_by?: string | null
          rescore?: number | null
          rewrites?: Json | null
          snapshot?: Json | null
          social_account_id: string
          started_at?: string | null
          status?: string
          summary?: string | null
          tokens_input?: number | null
          tokens_output?: number | null
          total_score?: number | null
        }
        Update: {
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          items?: Json | null
          manual_input?: Json
          model?: string | null
          organization_id?: string
          requested_by?: string | null
          rescore?: number | null
          rewrites?: Json | null
          snapshot?: Json | null
          social_account_id?: string
          started_at?: string | null
          status?: string
          summary?: string | null
          tokens_input?: number | null
          tokens_output?: number | null
          total_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "profile_reviews_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_reviews_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          organization_id: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          organization_id?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          organization_id?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      publish_jobs: {
        Row: {
          attempts: number
          cancelled_at: string | null
          caption_override: string | null
          completed_at: string | null
          content_id: string
          created_at: string
          deleted_at: string | null
          id: string
          is_ai_generated: boolean
          last_error: string | null
          platform_post_id: string | null
          platform_post_url: string | null
          post_type: Database["public"]["Enums"]["post_type"]
          resume_state: Json | null
          scheduled_for: string | null
          series_id: string | null
          series_reply_enabled: boolean
          social_account_id: string
          status: Database["public"]["Enums"]["publish_status"]
          status_history: Json
          updated_at: string
        }
        Insert: {
          attempts?: number
          cancelled_at?: string | null
          caption_override?: string | null
          completed_at?: string | null
          content_id: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_ai_generated?: boolean
          last_error?: string | null
          platform_post_id?: string | null
          platform_post_url?: string | null
          post_type: Database["public"]["Enums"]["post_type"]
          resume_state?: Json | null
          scheduled_for?: string | null
          series_id?: string | null
          series_reply_enabled?: boolean
          social_account_id: string
          status?: Database["public"]["Enums"]["publish_status"]
          status_history?: Json
          updated_at?: string
        }
        Update: {
          attempts?: number
          cancelled_at?: string | null
          caption_override?: string | null
          completed_at?: string | null
          content_id?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_ai_generated?: boolean
          last_error?: string | null
          platform_post_id?: string | null
          platform_post_url?: string | null
          post_type?: Database["public"]["Enums"]["post_type"]
          resume_state?: Json | null
          scheduled_for?: string | null
          series_id?: string | null
          series_reply_enabled?: boolean
          social_account_id?: string
          status?: Database["public"]["Enums"]["publish_status"]
          status_history?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "publish_jobs_content_id_fkey"
            columns: ["content_id"]
            isOneToOne: false
            referencedRelation: "contents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "publish_jobs_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      episode_alert_replies: {
        Row: {
          comment_text: string | null
          commented_at: string | null
          commenter_ig_id: string | null
          commenter_username: string | null
          created_at: string
          error: string | null
          id: string
          ig_comment_id: string
          reply_ig_id: string | null
          reply_text: string | null
          sent_at: string | null
          skip_reason: string | null
          source_episode_id: string | null
          status: "PENDING" | "SENT" | "SKIPPED" | "EXCLUDED" | "FAILED"
          task_id: string
        }
        Insert: {
          comment_text?: string | null
          commented_at?: string | null
          commenter_ig_id?: string | null
          commenter_username?: string | null
          created_at?: string
          error?: string | null
          id?: string
          ig_comment_id: string
          reply_ig_id?: string | null
          reply_text?: string | null
          sent_at?: string | null
          skip_reason?: string | null
          source_episode_id?: string | null
          status?: "PENDING" | "SENT" | "SKIPPED" | "EXCLUDED" | "FAILED"
          task_id: string
        }
        Update: {
          comment_text?: string | null
          commented_at?: string | null
          commenter_ig_id?: string | null
          commenter_username?: string | null
          created_at?: string
          error?: string | null
          id?: string
          ig_comment_id?: string
          reply_ig_id?: string | null
          reply_text?: string | null
          sent_at?: string | null
          skip_reason?: string | null
          source_episode_id?: string | null
          status?: "PENDING" | "SENT" | "SKIPPED" | "EXCLUDED" | "FAILED"
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "episode_alert_replies_source_episode_id_fkey"
            columns: ["source_episode_id"]
            isOneToOne: false
            referencedRelation: "series_episodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episode_alert_replies_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "episode_alert_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      episode_alert_settings: {
        Row: {
          daily_limit: number
          organization_id: string
          social_account_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          daily_limit?: number
          organization_id: string
          social_account_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          daily_limit?: number
          organization_id?: string
          social_account_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "episode_alert_settings_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: true
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      episode_alert_tasks: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string | null
          error_count: number
          id: string
          include_older: boolean
          last_checked_at: string | null
          last_comment_count: number | null
          last_error: string | null
          locked_at: string | null
          organization_id: string
          scheduled_for: string
          series_id: string
          social_account_id: string
          source_episode_id: string
          status: 
            | "COLLECTING"
            | "SENDING"
            | "DONE"
            | "FAILED"
            | "CANCELLED"
          target_episode_id: string
          updated_at: string
          watch_until: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error_count?: number
          id?: string
          include_older?: boolean
          last_checked_at?: string | null
          last_comment_count?: number | null
          last_error?: string | null
          locked_at?: string | null
          organization_id: string
          scheduled_for?: string
          series_id: string
          social_account_id: string
          source_episode_id: string
          status?: 
            | "COLLECTING"
            | "SENDING"
            | "DONE"
            | "FAILED"
            | "CANCELLED"
          target_episode_id: string
          updated_at?: string
          watch_until?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error_count?: number
          id?: string
          include_older?: boolean
          last_checked_at?: string | null
          last_comment_count?: number | null
          last_error?: string | null
          locked_at?: string | null
          organization_id?: string
          scheduled_for?: string
          series_id?: string
          social_account_id?: string
          source_episode_id?: string
          status?: 
            | "COLLECTING"
            | "SENDING"
            | "DONE"
            | "FAILED"
            | "CANCELLED"
          target_episode_id?: string
          updated_at?: string
          watch_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "episode_alert_tasks_series_id_fkey"
            columns: ["series_id"]
            isOneToOne: false
            referencedRelation: "series"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episode_alert_tasks_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episode_alert_tasks_source_episode_id_fkey"
            columns: ["source_episode_id"]
            isOneToOne: false
            referencedRelation: "series_episodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episode_alert_tasks_target_episode_id_fkey"
            columns: ["target_episode_id"]
            isOneToOne: true
            referencedRelation: "series_episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      series: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          id: string
          name: string
          organization_id: string
          reply_templates: string[]
          social_account_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name: string
          organization_id: string
          reply_templates?: string[]
          social_account_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          id?: string
          name?: string
          organization_id?: string
          reply_templates?: string[]
          social_account_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "series_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      series_episodes: {
        Row: {
          caption: string | null
          content_id: string | null
          created_at: string
          episode_no: number
          id: string
          ig_media_id: string
          media_type: string | null
          permalink: string | null
          posted_at: string | null
          publish_job_id: string | null
          reply_enabled: boolean
          series_id: string
        }
        Insert: {
          caption?: string | null
          content_id?: string | null
          created_at?: string
          episode_no: number
          id?: string
          ig_media_id: string
          media_type?: string | null
          permalink?: string | null
          posted_at?: string | null
          publish_job_id?: string | null
          reply_enabled?: boolean
          series_id: string
        }
        Update: {
          caption?: string | null
          content_id?: string | null
          created_at?: string
          episode_no?: number
          id?: string
          ig_media_id?: string
          media_type?: string | null
          permalink?: string | null
          posted_at?: string | null
          publish_job_id?: string | null
          reply_enabled?: boolean
          series_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "series_episodes_series_id_fkey"
            columns: ["series_id"]
            isOneToOne: false
            referencedRelation: "series"
            referencedColumns: ["id"]
          },
        ]
      }
      shoot_archive_clips: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          organization_id: string
          path: string
          product_id: string
          seconds: number
          shoot_request_id: string | null
          source_path: string
          source_start: number
          use_count: number
          what: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          organization_id: string
          path: string
          product_id: string
          seconds: number
          shoot_request_id?: string | null
          source_path: string
          source_start: number
          use_count?: number
          what: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          organization_id?: string
          path?: string
          product_id?: string
          seconds?: number
          shoot_request_id?: string | null
          source_path?: string
          source_start?: number
          use_count?: number
          what?: string
        }
        Relationships: [
          {
            foreignKeyName: "shoot_archive_clips_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shoot_archive_clips_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shoot_archive_clips_shoot_request_id_fkey"
            columns: ["shoot_request_id"]
            isOneToOne: false
            referencedRelation: "shoot_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      shoot_requests: {
        Row: {
          archive_attempts: number
          archived_at: string | null
          clips: Json
          created_at: string
          cuts: Json
          due_at: string | null
          edit: Json | null
          error: string | null
          id: string
          organization_id: string
          plan_id: string
          rendered_path: string | null
          status: string
          updated_at: string
          uploaded_at: string | null
        }
        Insert: {
          archive_attempts?: number
          archived_at?: string | null
          clips?: Json
          created_at?: string
          cuts?: Json
          due_at?: string | null
          edit?: Json | null
          error?: string | null
          id?: string
          organization_id: string
          plan_id: string
          rendered_path?: string | null
          status?: string
          updated_at?: string
          uploaded_at?: string | null
        }
        Update: {
          archive_attempts?: number
          archived_at?: string | null
          clips?: Json
          created_at?: string
          cuts?: Json
          due_at?: string | null
          edit?: Json | null
          error?: string | null
          id?: string
          organization_id?: string
          plan_id?: string
          rendered_path?: string | null
          status?: string
          updated_at?: string
          uploaded_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shoot_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shoot_requests_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: true
            referencedRelation: "content_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      shop_categories: {
        Row: {
          category_id: number
          collect: boolean
          kind: string | null
          name: string
          parent_id: number | null
          seen_at: string
          shop_code: string
        }
        Insert: {
          category_id: number
          collect?: boolean
          kind?: string | null
          name: string
          parent_id?: number | null
          seen_at?: string
          shop_code: string
        }
        Update: {
          category_id?: number
          collect?: boolean
          kind?: string | null
          name?: string
          parent_id?: number | null
          seen_at?: string
          shop_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "shop_categories_shop_code_fkey"
            columns: ["shop_code"]
            isOneToOne: false
            referencedRelation: "shops"
            referencedColumns: ["code"]
          },
        ]
      }
      shops: {
        Row: {
          api_base: string
          code: string
          created_at: string
          enabled: boolean
          name: string
          site_base: string
        }
        Insert: {
          api_base: string
          code: string
          created_at?: string
          enabled?: boolean
          name: string
          site_base: string
        }
        Update: {
          api_base?: string
          code?: string
          created_at?: string
          enabled?: boolean
          name?: string
          site_base?: string
        }
        Relationships: [

        ]
      }
      slot_rules: {
        Row: {
          active: boolean
          created_at: string
          id: string
          organization_id: string
          slot_time: string
          social_account_id: string
          track: string
          topic: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          organization_id: string
          slot_time: string
          social_account_id: string
          track: string
          topic?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          organization_id?: string
          slot_time?: string
          social_account_id?: string
          track?: string
          topic?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "slot_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "slot_rules_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_music: {
        Row: {
          checked_at: string
          creator: string | null
          landing: string | null
          last_used_at: string | null
          license: string | null
          reason: string | null
          rejected: boolean
          title: string | null
          track_id: string
        }
        Insert: {
          checked_at?: string
          creator?: string | null
          landing?: string | null
          last_used_at?: string | null
          license?: string | null
          reason?: string | null
          rejected?: boolean
          title?: string | null
          track_id: string
        }
        Update: {
          checked_at?: string
          creator?: string | null
          landing?: string | null
          last_used_at?: string | null
          license?: string | null
          reason?: string | null
          rejected?: boolean
          title?: string | null
          track_id?: string
        }
        Relationships: []
      }
      stock_searches: {
        Row: {
          fetched_at: string
          hits: Json
          query: string
        }
        Insert: {
          fetched_at?: string
          hits?: Json
          query: string
        }
        Update: {
          fetched_at?: string
          hits?: Json
          query?: string
        }
        Relationships: []
      }
      stock_videos: {
        Row: {
          checked_at: string
          page_url: string | null
          provider: string
          reason: string | null
          rejected: boolean
          video_id: number
        }
        Insert: {
          checked_at?: string
          page_url?: string | null
          provider: string
          reason?: string | null
          rejected?: boolean
          video_id: number
        }
        Update: {
          checked_at?: string
          page_url?: string | null
          provider?: string
          reason?: string | null
          rejected?: boolean
          video_id?: number
        }
        Relationships: []
      }
      social_accounts: {
        Row: {
          access_token_encrypted: string | null
          avatar_url: string | null
          connected_by: string | null
          created_at: string
          disconnected_at: string | null
          display_name: string | null
          group_id: string | null
          id: string
          is_active: boolean
          organization_id: string
          platform: Database["public"]["Enums"]["social_platform"]
          platform_account_id: string
          refresh_token_encrypted: string | null
          token_expires_at: string | null
          updated_at: string
          granted_scopes: string[] | null
          role_focus: string | null
          role_note: string | null
        }
        Insert: {
          access_token_encrypted?: string | null
          avatar_url?: string | null
          connected_by?: string | null
          created_at?: string
          disconnected_at?: string | null
          display_name?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean
          organization_id: string
          platform: Database["public"]["Enums"]["social_platform"]
          platform_account_id: string
          refresh_token_encrypted?: string | null
          token_expires_at?: string | null
          updated_at?: string
          granted_scopes?: string[] | null
          role_focus?: string | null
          role_note?: string | null
        }
        Update: {
          access_token_encrypted?: string | null
          avatar_url?: string | null
          connected_by?: string | null
          created_at?: string
          disconnected_at?: string | null
          display_name?: string | null
          group_id?: string | null
          id?: string
          is_active?: boolean
          organization_id?: string
          platform?: Database["public"]["Enums"]["social_platform"]
          platform_account_id?: string
          refresh_token_encrypted?: string | null
          token_expires_at?: string | null
          updated_at?: string
          granted_scopes?: string[] | null
          role_focus?: string | null
          role_note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_accounts_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_accounts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "account_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      social_posts: {
        Row: {
          caption: string | null
          first_seen_at: string
          id: string
          media_product_type: string | null
          media_type: string | null
          organization_id: string
          permalink: string | null
          platform_media_id: string
          posted_at: string | null
          publish_job_id: string | null
          social_account_id: string
          insights_checked_at: string | null
          thumb_path: string | null
          thumbnail_url: string | null
          updated_at: string
        }
        Insert: {
          caption?: string | null
          first_seen_at?: string
          id?: string
          insights_checked_at?: string | null
          media_product_type?: string | null
          media_type?: string | null
          organization_id: string
          permalink?: string | null
          platform_media_id: string
          posted_at?: string | null
          publish_job_id?: string | null
          social_account_id: string
          thumb_path?: string | null
          thumbnail_url?: string | null
          updated_at?: string
        }
        Update: {
          caption?: string | null
          first_seen_at?: string
          id?: string
          insights_checked_at?: string | null
          media_product_type?: string | null
          media_type?: string | null
          organization_id?: string
          permalink?: string | null
          platform_media_id?: string
          posted_at?: string | null
          publish_job_id?: string | null
          social_account_id?: string
          thumb_path?: string | null
          thumbnail_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_posts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_posts_publish_job_id_fkey"
            columns: ["publish_job_id"]
            isOneToOne: false
            referencedRelation: "publish_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_posts_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      track_settings: {
        Row: {
          a_shoot_deadline: string
          b_confirm_deadline: string
          b_full_auto: boolean
          organization_id: string
          product_scopes: Json
          repeat_gap_days: number
          shoot_enabled: boolean
          social_account_id: string
          updated_at: string
        }
        Insert: {
          a_shoot_deadline?: string
          b_confirm_deadline?: string
          b_full_auto?: boolean
          organization_id: string
          product_scopes?: Json
          repeat_gap_days?: number
          shoot_enabled?: boolean
          social_account_id: string
          updated_at?: string
        }
        Update: {
          a_shoot_deadline?: string
          b_confirm_deadline?: string
          b_full_auto?: boolean
          organization_id?: string
          product_scopes?: Json
          repeat_gap_days?: number
          shoot_enabled?: boolean
          social_account_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "track_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "track_settings_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: true
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_runs: {
        Row: {
          error: string | null
          finished_at: string | null
          github_run_url: string | null
          id: string
          started_at: string
          status: string
          summary: Json
          trigger: string | null
          worker: string
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          github_run_url?: string | null
          id?: string
          started_at?: string
          status?: string
          summary?: Json
          trigger?: string | null
          worker: string
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          github_run_url?: string | null
          id?: string
          started_at?: string
          status?: string
          summary?: Json
          trigger?: string | null
          worker?: string
        }
        Relationships: [

        ]
      }
    }
    Views: {
      account_post_stats: {
        Row: {
          avg_watch_time_ms: number | null
          caption: string | null
          comments: number | null
          insights_checked_at: string | null
          likes: number | null
          media_product_type: string | null
          media_type: string | null
          organization_id: string | null
          permalink: string | null
          platform_media_id: string | null
          post_id: string | null
          posted_at: string | null
          reach: number | null
          saved: number | null
          shares: number | null
          social_account_id: string | null
          thumb_path: string | null
          thumbnail_url: string | null
          views: number | null
        }
        Relationships: []
      }
      account_reel_stats: {
        Row: {
          avg_watch_time_ms: number | null
          caption: string | null
          comments: number | null
          insights_checked_at: string | null
          likes: number | null
          organization_id: string | null
          permalink: string | null
          platform_media_id: string | null
          post_id: string | null
          posted_at: string | null
          reach: number | null
          saved: number | null
          shares: number | null
          social_account_id: string | null
          thumb_path: string | null
          thumbnail_url: string | null
          views: number | null
        }
        Relationships: []
      }
      episode_alert_task_stats: {
        Row: {
          excluded: number | null
          failed: number | null
          pending: number | null
          sent: number | null
          sent_older: number | null
          skipped: number | null
          task_id: string | null
          total: number | null
        }
        Relationships: []
      }
      post_latest_metrics: {
        Row: {
          avg_watch_time_ms: number | null
          collected_on: string | null
          comments: number | null
          likes: number | null
          post_id: string | null
          reach: number | null
          saved: number | null
          shares: number | null
          total_interactions: number | null
          views: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_invitation: { Args: { p_token: string }; Returns: string }
      add_series_episode: {
        Args: {
          p_caption?: string | null
          p_content_id?: string | null
          p_ig_media_id: string
          p_media_type?: string | null
          p_permalink?: string | null
          p_posted_at?: string | null
          p_publish_job_id?: string | null
          p_series_id: string
        }
        Returns: Database["public"]["Tables"]["series_episodes"]["Row"]
      }
      claim_due_publish_jobs: {
        Args: {
          p_limit?: number
          p_max_attempts?: number
          p_stale_minutes?: number
        }
        Returns: Database["public"]["Tables"]["publish_jobs"]["Row"][]
      }
      claim_products_for_analysis: {
        Args: { p_limit: number; p_lock_minutes: number }
        Returns: Database["public"]["Tables"]["products"]["Row"][]
      }
      claim_episode_alert_tasks: {
        Args: { p_limit?: number; p_stale_minutes?: number }
        Returns: Database["public"]["Tables"]["episode_alert_tasks"]["Row"][]
      }
      create_invitation: {
        Args: {
          p_email: string
          p_role?: Database["public"]["Enums"]["user_role"]
        }
        Returns: string
      }
      create_organization: { Args: { p_name: string }; Returns: string }
      current_org_id: { Args: never; Returns: string }
      current_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      verify_episode_replies_cron_secret: {
        Args: { p_secret: string }
        Returns: boolean
      }
    }
    Enums: {
      media_type: "VIDEO" | "IMAGE"
      post_type:
        | "SHORTS"
        | "REELS"
        | "FEED"
        | "CAROUSEL"
        | "PHOTO_MODE"
        | "VIDEO"
        | "PHOTO"
      publish_status:
        | "PENDING"
        | "PROCESSING"
        | "SUCCESS"
        | "FAILED"
        | "RETRYING"
        | "CANCELLED"
      social_platform: "YOUTUBE" | "INSTAGRAM" | "TIKTOK"
      user_role: "ADMIN" | "MANAGER" | "STAFF"
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
    Enums: {
      media_type: ["VIDEO", "IMAGE"],
      post_type: [
        "SHORTS",
        "REELS",
        "FEED",
        "CAROUSEL",
        "PHOTO_MODE",
        "VIDEO",
        "PHOTO",
      ],
      publish_status: [
        "PENDING",
        "PROCESSING",
        "SUCCESS",
        "FAILED",
        "RETRYING",
        "CANCELLED",
      ],
      social_platform: ["YOUTUBE", "INSTAGRAM", "TIKTOK"],
      user_role: ["ADMIN", "MANAGER", "STAFF"],
    },
  },
} as const
