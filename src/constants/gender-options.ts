export interface GenderOption {
  value: string;
  label: string;
}

export const GENDER_OPTIONS: GenderOption[] = [
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
  { value: 'Prefer not to say', label: 'Prefer not to say' },
];

export function getGenderLabel(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return GENDER_OPTIONS.find((option) => option.value === trimmed)?.label ?? trimmed;
}
