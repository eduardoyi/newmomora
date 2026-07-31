import {
  capturePrompt,
  defaultFamilyName,
  firstPageCaption,
  kidsPhrase,
  possessive,
  possessiveHeadline,
} from '@/utils/onboarding-copy';

describe('kidsPhrase', () => {
  it('returns an empty string for no names', () => {
    expect(kidsPhrase([])).toBe('');
  });

  it('returns the single name unchanged', () => {
    expect(kidsPhrase(['Lila'])).toBe('Lila');
  });

  it('joins two names with "&"', () => {
    expect(kidsPhrase(['Lila', 'Miguel'])).toBe('Lila & Miguel');
  });

  it('joins three or more names with commas and a trailing "&"', () => {
    expect(kidsPhrase(['Lila', 'Miguel', 'Teo'])).toBe('Lila, Miguel & Teo');
  });

  it('drops blank/whitespace-only entries', () => {
    expect(kidsPhrase(['Lila', '  ', 'Miguel'])).toBe('Lila & Miguel');
  });
});

describe('possessive', () => {
  it('adds "\'s" to names not ending in s', () => {
    expect(possessive('Lila')).toBe("Lila's");
  });

  it('adds only an apostrophe to names ending in s', () => {
    expect(possessive('Chris')).toBe("Chris'");
    expect(possessive('James')).toBe("James'");
  });

  it('returns an empty string unchanged', () => {
    expect(possessive('')).toBe('');
  });
});

describe('defaultFamilyName', () => {
  it('returns an empty string for no names', () => {
    expect(defaultFamilyName([])).toBe('');
  });

  it('builds a possessive family name for one kid', () => {
    expect(defaultFamilyName(['Lila'])).toBe("Lila's Family");
  });

  it('builds a possessive family name for two kids', () => {
    expect(defaultFamilyName(['Lila', 'Miguel'])).toBe("Lila & Miguel's Family");
  });

  it('builds a possessive family name for three kids', () => {
    expect(defaultFamilyName(['Lila', 'Miguel', 'Teo'])).toBe("Lila, Miguel & Teo's Family");
  });

  it('only considers the first three kids', () => {
    expect(defaultFamilyName(['Lila', 'Miguel', 'Teo', 'Ana'])).toBe("Lila, Miguel & Teo's Family");
  });

  it('applies the s-ending possessive rule to the last name', () => {
    expect(defaultFamilyName(['Lila', 'Chris'])).toBe("Lila & Chris' Family");
  });
});

describe('capturePrompt', () => {
  it('asks about the single kid by name', () => {
    expect(capturePrompt(['Lila'], [0])).toBe(
      "What's something small Lila did this week that made you smile?",
    );
  });

  it('asks about the single kid even with no selection passed', () => {
    expect(capturePrompt(['Lila'], [])).toBe(
      "What's something small Lila did this week that made you smile?",
    );
  });

  it('asks about the selected kid by name when one of several is selected', () => {
    expect(capturePrompt(['Lila', 'Miguel'], [1])).toBe(
      "What's something small Miguel did this week that made you smile?",
    );
  });

  it('falls back to the neutral prompt with no kid names at all', () => {
    expect(capturePrompt([], [])).toBe("What's something small from this week that made you smile?");
  });

  it('falls back to the neutral prompt for a blank single kid name', () => {
    expect(capturePrompt([''], [])).toBe("What's something small from this week that made you smile?");
  });

  it('falls back to the neutral prompt when the single selected index is out of range', () => {
    expect(capturePrompt(['Lila', 'Miguel'], [5])).toBe(
      "What's something small from this week that made you smile?",
    );
  });

  it('uses "the two of them" when two kids are selected', () => {
    expect(capturePrompt(['Lila', 'Miguel', 'Teo'], [0, 1])).toBe(
      "What's something small the two of them did this week that made you smile?",
    );
  });

  it('uses "all of them" when three or more kids are selected', () => {
    expect(capturePrompt(['Lila', 'Miguel', 'Teo'], [0, 1, 2])).toBe(
      "What's something small all of them did this week that made you smile?",
    );
  });

  it('defaults to "all of them" for a multi-kid family with no selection', () => {
    expect(capturePrompt(['Lila', 'Miguel'], [])).toBe(
      "What's something small all of them did this week that made you smile?",
    );
  });

  it('still uses "all of them" for a larger family (five kids selected)', () => {
    expect(capturePrompt(['Lila', 'Miguel', 'Teo', 'Ana', 'Sam'], [0, 1, 2, 3, 4])).toBe(
      "What's something small all of them did this week that made you smile?",
    );
  });
});

describe('firstPageCaption', () => {
  it('names the single tagged kid', () => {
    expect(firstPageCaption(['Lila'])).toBe("Lila's first page. Imagine a year of these.");
  });

  it('applies the possessive s-ending rule', () => {
    expect(firstPageCaption(['Chris'])).toBe("Chris' first page. Imagine a year of these.");
  });

  it('uses "Their" when more than one kid is tagged', () => {
    expect(firstPageCaption(['Lila', 'Miguel'])).toBe('Their first page. Imagine a year of these.');
  });
});

describe('possessiveHeadline', () => {
  it('names the single kid', () => {
    expect(possessiveHeadline(['Lila'])).toBe("Lila's stories need a home.");
  });

  it('uses "Their" for more than one kid', () => {
    expect(possessiveHeadline(['Lila', 'Miguel'])).toBe('Their stories need a home.');
  });
});
