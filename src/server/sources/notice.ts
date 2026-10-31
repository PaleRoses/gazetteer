import type { PortId, ReportContext } from '../../shared';

export type NoticeKind = 'cyclone' | 'flood' | 'volcano' | 'earthquake' | 'weather' | 'security';
export type NoticeSeverity = 'minor' | 'moderate' | 'severe' | 'extreme';
export type NoticeProvider = 'gdacs' | 'nws' | 'usgs' | 'ap' | 'marad';
export type LonLat = readonly [number, number];

export type NoticeGeometry =
  | Readonly<{ kind: 'point'; coordinates: LonLat }>
  | Readonly<{ kind: 'bbox'; west: number; south: number; east: number; north: number }>
  | Readonly<{ kind: 'zone'; zoneIds: readonly string[]; portIds: readonly PortId[] }>;

export type Notice = Readonly<{
  id: string; provider: NoticeProvider; kind: NoticeKind; severity: NoticeSeverity;
  title: string; detail: string; observedAt: string; expiresAt: string | null;
  geometry: NoticeGeometry; url: string; fetchedAt: string; provenance: 'live'; report?: ReportContext;
}>;

export type FetchResult =
  | Readonly<{ status: 'ok'; provider: NoticeProvider; notices: readonly Notice[] }>
  | Readonly<{ status: 'unavailable'; provider: NoticeProvider; message: string }>;

export const userAgent = 'gazetteer-demo/0.1 (+https://github.com/PaleRoses/gazetteer; hackathon demo, contact rosaliafialkova@gmail.com)';
