// Shared calendar types. The Calendar tab's week-ribbon math (week building,
// month-jump index, height model, jump correction) was removed with the tab
// (docs/plans/timeline-calendar-keepsakes.md C1); the Timeline month grid's
// math lives in calendar-grid.ts and the month picker's in timeline-anchor.ts.

export interface CalendarFetchRange {
  startDate: string;
  endDate: string;
}

export interface CalendarMonthOption {
  year: number;
  month: number; // 0-11, JS Date convention
  label: string;
  iso: string; // first-of-month ISO date; stable list key
  isCurrent: boolean;
}
