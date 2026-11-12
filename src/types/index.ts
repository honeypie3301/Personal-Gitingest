export type IngestionOutputFormat = 'text' | 'zip';

export type PatternType = 'exclude' | 'include';

export interface IngestFileEvent {
  path: string;
  status: 'ingesting' | 'decompiling' | 'completed' | 'binary';
  count: number;
  total?: number;
}

export interface IngestRequest {
  input_text: string;
  max_file_size?: number; // In MB (legacy checks decoded UTF-16 character length)
  pattern_type?: PatternType;
  pattern?: string;
  token?: string;
  decompile_classes?: boolean;
  output_format?: IngestionOutputFormat;
  onProgress?: (event: IngestFileEvent) => void;
}

export interface IngestResponse {
  summary: string;
  tree: string;
  content: string;
  repo_name?: string;
  subpath?: string;
  files_analyzed?: number;
  estimated_tokens?: string;
  total_chars?: number;
  error?: string;
  artifact_url?: string;
  content_preview_truncated?: boolean;
  tree_preview_truncated?: boolean;
  content_offset?: number;
  content_chars?: number;
  mode_info?: string;
  mode_switched?: boolean;
  output_format?: IngestionOutputFormat;
  files?: Array<{ path: string; text?: string }>;
  // Browser-only callback; credentials stay in its closure, never in worker metadata.
  refreshArtifactUrl?: () => Promise<string>;
}

export interface GitHubUser {
  id?: number;
  node_id?: string;
  login: string;
  avatar_url: string;
  name?: string;
  html_url?: string;
}

export interface TokenStatus {
  configured: boolean;
  source: 'server_env' | 'saved_pat' | 'none';
  user?: GitHubUser | null;
}
