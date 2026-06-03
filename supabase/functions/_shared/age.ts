export function getAgeInYearsAtDate(dateOfBirth: string, referenceDate: string): number | null {
  const birthDate = new Date(`${dateOfBirth}T00:00:00`);
  const refDate = new Date(`${referenceDate}T00:00:00`);

  if (Number.isNaN(birthDate.getTime()) || Number.isNaN(refDate.getTime())) {
    return null;
  }

  let years = refDate.getFullYear() - birthDate.getFullYear();
  let months = refDate.getMonth() - birthDate.getMonth();

  if (refDate.getDate() < birthDate.getDate()) {
    months -= 1;
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  if (years < 0) {
    return null;
  }

  return years;
}

export function isAdultAtDate(dateOfBirth: string, referenceDate: string, adultThreshold = 18): boolean {
  const ageYears = getAgeInYearsAtDate(dateOfBirth, referenceDate);
  return ageYears !== null && ageYears >= adultThreshold;
}

export function describeAgeAtDate(dateOfBirth: string, referenceDate: string): string {
  const birthDate = new Date(`${dateOfBirth}T00:00:00`);
  const refDate = new Date(`${referenceDate}T00:00:00`);

  if (Number.isNaN(birthDate.getTime()) || Number.isNaN(refDate.getTime())) {
    return 'young child';
  }

  let years = refDate.getFullYear() - birthDate.getFullYear();
  let months = refDate.getMonth() - birthDate.getMonth();

  if (refDate.getDate() < birthDate.getDate()) {
    months -= 1;
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  if (years <= 0) {
    return months <= 0 ? 'newborn' : `${months} month${months === 1 ? '' : 's'} old`;
  }

  if (months === 0) {
    return `${years} year${years === 1 ? '' : 's'} old`;
  }

  return `${years} year${years === 1 ? '' : 's'} and ${months} month${months === 1 ? '' : 's'} old`;
}
