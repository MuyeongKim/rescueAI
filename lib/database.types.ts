// 수작성 Supabase 타입 (supabase/migrations 의 §6 스키마와 1:1 대응).
// 실제 프로젝트 연결 후 `supabase gen types typescript`로 재생성 권장.
// 주의: Update 타입은 순환참조(Partial<Database[...]>)를 피하려고 독립 alias로 정의한다.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type DocSource = {
  document_id: number;
  doc: string;
  page: number | null;
  content: string;
};

// ── profiles ──
type ProfilesRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  division: string | null;
  rank: string | null;
  team: string | null;
  digital_id: string | null;
  must_change_password: boolean;
  created_at: string;
};
type ProfilesInsert = {
  id: string;
  email?: string | null;
  full_name?: string | null;
  role?: string;
  division?: string | null;
  rank?: string | null;
  team?: string | null;
  digital_id?: string | null;
  must_change_password?: boolean;
  created_at?: string;
};

// ── documents ──
type DocumentsRow = {
  id: number;
  title: string;
  source_type: string;
  category: string | null;
  equipment: string[] | null;
  difficulty: string | null;
  original_filename: string | null;
  file_url: string | null;
  publish_date: string | null;
  status: string;
  created_at: string;
};
type DocumentsInsert = {
  id?: number;
  title: string;
  source_type: string;
  category?: string | null;
  equipment?: string[] | null;
  difficulty?: string | null;
  original_filename?: string | null;
  file_url?: string | null;
  publish_date?: string | null;
  status?: string;
  created_at?: string;
};

// ── chunks ──
type ChunksRow = {
  id: number;
  document_id: number | null;
  content: string;
  embedding: string | null;
  page_num: number | null;
  section_title: string | null;
  metadata: Json;
  created_at: string;
};
type ChunksInsert = {
  id?: number;
  document_id?: number | null;
  content: string;
  embedding?: string | null;
  page_num?: number | null;
  section_title?: string | null;
  metadata?: Json;
  created_at?: string;
};

// ── conversations ──
type ConversationsRow = {
  id: string;
  user_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
};
type ConversationsInsert = {
  id?: string;
  user_id?: string | null;
  title?: string | null;
  created_at?: string;
  updated_at?: string;
};

// ── messages ──
type MessagesRow = {
  id: number;
  conversation_id: string | null;
  role: string;
  content: string;
  sources: DocSource[] | null;
  feedback: number | null;
  latency_ms: number | null;
  created_at: string;
};
type MessagesInsert = {
  id?: number;
  conversation_id?: string | null;
  role: string;
  content: string;
  sources?: DocSource[] | null;
  feedback?: number | null;
  latency_ms?: number | null;
  created_at?: string;
};

// ── lesson_progress ──
type LessonProgressRow = {
  id: number;
  user_id: string | null;
  document_id: number | null;
  created_at: string;
};
type LessonProgressInsert = {
  id?: number;
  user_id?: string | null;
  document_id?: number | null;
  created_at?: string;
};

// ── news (구조 동향) ──
type NewsRow = {
  id: number;
  title: string;
  summary: string | null;
  source: string | null;
  url: string | null;
  region: string | null;
  category: string | null;
  published_on: string | null;
  pinned: boolean;
  hidden: boolean;
  auto: boolean;
  created_by: string | null;
  created_at: string;
};
type NewsInsert = {
  id?: number;
  title: string;
  summary?: string | null;
  source?: string | null;
  url?: string | null;
  region?: string | null;
  category?: string | null;
  published_on?: string | null;
  pinned?: boolean;
  hidden?: boolean;
  auto?: boolean;
  created_by?: string | null;
  created_at?: string;
};

// ── notices ──
type NoticesRow = {
  id: number;
  title: string;
  content: string;
  pinned: boolean;
  created_by: string | null;
  created_at: string;
};
type NoticesInsert = {
  id?: number;
  title: string;
  content: string;
  pinned?: boolean;
  created_by?: string | null;
  created_at?: string;
};

// ── workout_logs ──
type WorkoutLogsRow = {
  id: number;
  user_id: string | null;
  activity: string;
  duration_min: number;
  note: string | null;
  points: number;
  performed_on: string;
  created_at: string;
};
type WorkoutLogsInsert = {
  id?: number;
  user_id?: string | null;
  activity: string;
  duration_min: number;
  note?: string | null;
  points?: number;
  performed_on?: string;
  created_at?: string;
};

type GeneratedMaterialsRow = {
  id: number;
  user_id: string | null;
  kind: string;
  category: string | null;
  audience: string | null;
  duration: string | null;
  topic: string | null;
  title: string;
  content: unknown; // {sections|slides|prompt, sources}
  shared: boolean;
  author_name: string | null;
  created_at: string;
};
type GeneratedMaterialsInsert = {
  id?: number;
  user_id?: string | null;
  kind: string;
  category?: string | null;
  audience?: string | null;
  duration?: string | null;
  topic?: string | null;
  title: string;
  content: unknown;
  shared?: boolean;
  author_name?: string | null;
  created_at?: string;
};

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: ProfilesRow;
        Insert: ProfilesInsert;
        Update: Partial<ProfilesInsert>;
        Relationships: [];
      };
      documents: {
        Row: DocumentsRow;
        Insert: DocumentsInsert;
        Update: Partial<DocumentsInsert>;
        Relationships: [];
      };
      chunks: {
        Row: ChunksRow;
        Insert: ChunksInsert;
        Update: Partial<ChunksInsert>;
        Relationships: [];
      };
      conversations: {
        Row: ConversationsRow;
        Insert: ConversationsInsert;
        Update: Partial<ConversationsInsert>;
        Relationships: [];
      };
      messages: {
        Row: MessagesRow;
        Insert: MessagesInsert;
        Update: Partial<MessagesInsert>;
        Relationships: [];
      };
      lesson_progress: {
        Row: LessonProgressRow;
        Insert: LessonProgressInsert;
        Update: Partial<LessonProgressInsert>;
        Relationships: [];
      };
      notices: {
        Row: NoticesRow;
        Insert: NoticesInsert;
        Update: Partial<NoticesInsert>;
        Relationships: [];
      };
      news: {
        Row: NewsRow;
        Insert: NewsInsert;
        Update: Partial<NewsInsert>;
        Relationships: [];
      };
      workout_logs: {
        Row: WorkoutLogsRow;
        Insert: WorkoutLogsInsert;
        Update: Partial<WorkoutLogsInsert>;
        Relationships: [];
      };
      generated_materials: {
        Row: GeneratedMaterialsRow;
        Insert: GeneratedMaterialsInsert;
        Update: Partial<GeneratedMaterialsInsert>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      fitness_leaderboard: {
        Args: { since?: string | null };
        Returns: {
          user_id: string;
          full_name: string | null;
          division: string | null;
          total_points: number;
        }[];
      };
      hybrid_search: {
        Args: {
          query_text: string;
          query_embedding: string;
          match_count?: number;
          filter_category?: string | null;
        };
        Returns: {
          chunk_id: number;
          document_id: number;
          doc_title: string;
          content: string;
          page_num: number | null;
          rrf_score: number;
        }[];
      };
      popular_questions: {
        Args: { days?: number; min_count?: number; max_rows?: number };
        Returns: { question: string; cnt: number }[];
      };
      // 관리자 대시보드 집계(service role 전용) — jsonb 한 덩어리로 반환.
      // 필드 구성은 app/admin/page.tsx 의 AdminStats 와 1:1.
      admin_dashboard_stats: {
        Args: { p_days?: number; p_faq_limit?: number };
        Returns: {
          totalUsers: number;
          totalQuestions: number;
          avgLatencyMs: number;
          up: number;
          down: number;
          categories: { category: string; count: number }[];
          daily: { date: string; count: number }[];
          faq: { q: string; count: number }[];
        };
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
