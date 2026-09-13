export type PublicContentType = 'news' | 'event';
export type PublicOrigin =
  | 'editorial'
  | 'official_external'
  | 'user_submitted'
  | 'aggregated'
  | 'unknown';
export type PublicStatus = 'published' | 'scheduled' | 'cancelled' | 'postponed' | 'finished' | 'unknown';

export interface PublicProvenance {
  source_type: PublicOrigin;
  publisher: string;
  canonical_url: string;
  source_id: string;
  published_at: string | null;
  updated_at: string | null;
  retrieved_at: string;
}

export interface PublicCategory {
  id: string;
  name: string;
}

export interface PublicAuthor {
  id: string;
  name: string;
}

export interface PublicLocation {
  city: string | null;
  province: string | null;
  country: string | null;
}

export interface PublicImage {
  url: string;
  alt: string | null;
  thumbnail_url: string | null;
}

export interface PublicNews {
  id: string;
  type: 'news';
  origin: 'editorial';
  visibility: 'public';
  status: 'published';
  title: string;
  slug: string;
  summary: string;
  content: string;
  canonical_url: string;
  published_at: string;
  updated_at: string;
  language: 'es-AR';
  category: PublicCategory | null;
  author: PublicAuthor;
  location: PublicLocation | null;
  images: PublicImage[];
  provenance: PublicProvenance;
}

export interface PublicEvent {
  id: string;
  type: 'event';
  origin: PublicOrigin;
  visibility: 'public';
  status: Exclude<PublicStatus, 'published'>;
  name: string;
  summary: string;
  canonical_url: string;
  start_at: string;
  end_at: string | null;
  timezone: 'America/Argentina/Buenos_Aires';
  venue: {
    name: string | null;
    address: string | null;
    city: string | null;
  } | null;
  source: {
    url: string;
    updated_at: string | null;
  };
  provenance: PublicProvenance;
}

export interface PublicSearchMatch {
  kind: 'lexical';
  fields: Array<'title' | 'summary' | 'content'>;
}

export interface PublicSearchResult {
  id: string;
  type: PublicContentType;
  title: string;
  summary: string;
  canonical_url: string;
  published_at: string;
  score: number | null;
  match: PublicSearchMatch | null;
  provenance: PublicProvenance;
}

export interface PublicSnapshotLike {
  id: string;
  data(): unknown;
}
