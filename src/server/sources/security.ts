import type { Notice } from './notice';

// Editorial snapshots checked against the linked sources, not a polling news service.
// Kept out of liveSweep / port actors: these reports must never manufacture an ETA change.
// Re-review within seven days; an advisory may be withdrawn before its scheduled expiry.
export const securityReviewedAt = '2026-10-31T00:00:00Z';
const reviewUntil = '2026-11-07T00:00:00Z';
const ap = 'https://www.aol.co.uk/articles/saudi-arabia-says-drone-intercepted-082823000.html';
const reports: readonly Notice[] = [
  {
    id: 'security:reuters:2026-10-30:limpet-mines', provider: 'reuters', kind: 'security', severity: 'severe',
    title: 'Hormuz: tanker reportedly struck by hull-mounted explosives',
    detail: 'Reuters reported on October 30, citing maritime sources, that a small boat attached two limpet mines to a tanker, causing a fire and temporarily disabling it. This report may overlap other Hormuz incident reporting; it is not an additional confirmed incident count.',
    observedAt: '2026-10-30T11:44:00Z', expiresAt: '2026-11-06T11:44:00Z',
    geometry: { kind: 'point', coordinates: [56.8, 26.4] },
    url: 'https://www.marketscreener.com/news/tanker-in-strait-of-hormuz-hit-by-limpet-mines-security-sources-say-ce785fdbda8ef420',
    fetchedAt: securityReviewedAt, provenance: 'live',
    report: { kind: 'news', region: 'Strait of Hormuz / Oman approaches', reviewedAt: securityReviewedAt },
  },
  {
    id: 'security:ap:2026-10-30:lavan', provider: 'ap', kind: 'security', severity: 'severe',
    title: 'Persian Gulf: projectile strike reported south of Lavan',
    detail: 'AP cites UKMTO reporting on October 30 that a vessel was hit by an unidentified projectile south of Lavan Island. The crew was reported safe. The pin marks the wider area, not a verified incident position.',
    observedAt: '2026-10-30T21:10:00Z', expiresAt: '2026-11-06T21:10:00Z',
    geometry: { kind: 'point', coordinates: [53.3, 26.6] }, url: ap, fetchedAt: securityReviewedAt, provenance: 'live',
    report: { kind: 'news', region: 'Lavan / Persian Gulf', reviewedAt: securityReviewedAt },
  },
  {
    id: 'security:marad:2026-011:gnss', provider: 'marad', kind: 'security', severity: 'severe',
    title: 'Hormuz approaches: GPS spoofing and jamming warning',
    detail: 'MARAD advisory 2026-011 identifies ongoing GNSS interference, spoofing and jamming across Gulf waters. Position reports may be unreliable. This is a navigation warning from the same advisory as the regional security alert, not a separate attack report.',
    observedAt: '2026-09-09T00:00:00Z', expiresAt: reviewUntil,
    geometry: { kind: 'point', coordinates: [55.8, 25.8] },
    url: 'https://www.maritime.dot.gov/msci/2026-011-persian-gulf-strait-hormuz-and-gulf-oman-iranian-attacks-commercial-vessels',
    fetchedAt: securityReviewedAt, provenance: 'live',
    report: { kind: 'advisory', region: 'Hormuz approaches', reviewedAt: securityReviewedAt, validUntil: '2027-03-08' },
  },
  {
    id: 'security:ap:2026-10-30:hormuz', provider: 'ap', kind: 'security', severity: 'severe',
    title: 'Hormuz: Iran claims four tankers hit mines',
    detail: 'AP reports Iran’s claim that four tankers struck mines on October 30; AP could not verify it. Oman separately reported evacuating 25 crew from an attacked tanker. Whether the incidents are related is unclear.',
    observedAt: '2026-10-30T21:10:00Z', expiresAt: '2026-11-06T21:10:00Z',
    geometry: { kind: 'point', coordinates: [56.45, 26.6] }, url: ap, fetchedAt: securityReviewedAt, provenance: 'live',
    report: { kind: 'news', region: 'Strait of Hormuz', reviewedAt: securityReviewedAt },
  },
  {
    id: 'security:ap:2026-10-30:aden', provider: 'ap', kind: 'security', severity: 'severe',
    title: 'Aden: Yemeni military reports Houthi missile strikes',
    detail: 'AP reports that Yemen’s military attributed October 30 strikes on Aden’s airport and government palace to the Houthis. No casualties were reported; the Houthis had not immediately claimed responsibility. This is an onshore report, not a confirmed attack on shipping.',
    observedAt: '2026-10-30T21:10:00Z', expiresAt: '2026-11-06T21:10:00Z',
    geometry: { kind: 'point', coordinates: [45.03, 12.8] }, url: ap, fetchedAt: securityReviewedAt, provenance: 'live',
    report: { kind: 'news', region: 'Aden / Gulf of Aden', reviewedAt: securityReviewedAt },
  },
  {
    id: 'security:marad:2026-013', provider: 'marad', kind: 'security', severity: 'severe',
    title: 'Red Sea / Bab el-Mandeb: Houthi shipping threat',
    detail: 'MARAD advisory 2026-013 warns of Houthi attacks on commercial vessels across the Red Sea, Bab el-Mandeb and surrounding waters. It identifies elevated exposure for certain national and company affiliations. Review carrier security plans before assuming the Suez passage is available.',
    observedAt: '2026-09-23T00:00:00Z', expiresAt: reviewUntil,
    geometry: { kind: 'point', coordinates: [43.33, 12.58] },
    url: 'https://www.maritime.dot.gov/msci/2026-013-red-sea-bab-el-mandeb-strait-gulf-aden-arabian-sea-and-somali-basin-houthi-attacks',
    fetchedAt: securityReviewedAt, provenance: 'live',
    report: { kind: 'advisory', region: 'Bab el-Mandeb / Red Sea', reviewedAt: securityReviewedAt, validUntil: '2027-03-22' },
  },
  {
    id: 'security:marad:2026-011', provider: 'marad', kind: 'security', severity: 'severe',
    title: 'Strait of Hormuz: commercial shipping security advisory',
    detail: 'MARAD advisory 2026-011 warns of Iranian attacks and navigation hazards in the Persian Gulf, Strait of Hormuz and Gulf of Oman, including missile, drone and surface-vessel threats. Gulf-bound voyages need current security review; this does not establish a delay for any tracked ship.',
    observedAt: '2026-09-09T00:00:00Z', expiresAt: reviewUntil,
    geometry: { kind: 'point', coordinates: [57.4, 24.8] },
    url: 'https://www.maritime.dot.gov/msci/2026-011-persian-gulf-strait-hormuz-and-gulf-oman-iranian-attacks-commercial-vessels',
    fetchedAt: securityReviewedAt, provenance: 'live',
    report: { kind: 'advisory', region: 'Hormuz / Gulf of Oman', reviewedAt: securityReviewedAt, validUntil: '2027-03-08' },
  },
];

export const securityReports = (now: Date): readonly Notice[] => reports.filter(report =>
  Date.parse(report.observedAt) <= now.getTime() && now.getTime() < Date.parse(report.expiresAt!));
