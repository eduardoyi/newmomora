# Expo Router — Momora client

Parent instructions: [../AGENTS.md](../AGENTS.md)

## Route groups (planned)

```
app/
  (auth)/          login, signup, verify-otp
  (app)/           timeline, calendar, family, settings — tab layout
  (modals)/        new-memory, edit-memory, add-family-member
```

## Screen rules

- **Modals** for create/edit flows; pass ids via route params.
- **Onboarding gates** in `(app)/_layout.tsx`: no memory creation until first portrait `ready`.
- **New memory** opens from tab FAB, notification tap, or onboarding.
- **Empty states** must CTA to add child / first memory (child-first copy).

## UX requirements

| Flow | Rule |
|------|------|
| Memory save | Optimistic or immediate DB save; trigger AI after |
| Portrait wait | Show progress; don't allow dismiss during onboarding first portrait |
| Voice | Mic toggles record; 2-min auto-stop; processing spinner |
| Illustration | Status badge on cards; detail view retry button on `failed` |
| Tags | Multi-select, max 4, show member avatars |
| Keyboard | Any screen/modal/drawer with `TextInput` must keep the focused input and primary actions visible above the keyboard on iOS and Android |

## Testing

- Add `testID` to interactive elements for Maestro e2e.
- Colocate unit + `.integration.test.tsx` with hooks/components you build.
- See [docs/TESTING.md](../docs/TESTING.md).

## Don't

- Add web-only APIs without Platform checks.
- Navigate with imperative refs — use Expo Router `router.push`.
- Block UI on illustration completion — async status updates only.
- Ship client work for a major feature without updating `docs/features/<name>.md`.
