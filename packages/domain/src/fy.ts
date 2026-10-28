/** Indian financial year helpers (April–March). Dates are plain ISO yyyy-mm-dd in IST. */
export function fyStartYear(isoDate: string): number {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  return m >= 4 ? y : y - 1;
}

/** "2025-26" */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Period label aware of the regime change:
 * income up to FY 2025-26 → Income-tax Act 1961 (FY + AY);
 * from 1 Apr 2026 → Income-tax Act 2025 ("Tax Year").
 */
export function incomeTaxPeriodLabel(startYear: number): { regime: 'ITA1961' | 'ITA2025'; label: string } {
  if (startYear <= 2025) return { regime: 'ITA1961', label: `FY ${fyLabel(startYear)} (AY ${fyLabel(startYear + 1)})` };
  return { regime: 'ITA2025', label: `Tax Year ${fyLabel(startYear)}` };
}
