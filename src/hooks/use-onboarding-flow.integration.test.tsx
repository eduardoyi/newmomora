import { act, render, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import { OnboardingFlowProvider, useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useAuth } from '@/hooks/use-auth';
import { getOnboardingDraft, patchOnboardingDraft } from '@/utils/onboarding-progress';

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

function Probe({ onCapture }: { onCapture: (flow: ReturnType<typeof useOnboardingFlow>) => void }) {
  const flow = useOnboardingFlow();

  useEffect(() => {
    onCapture(flow);
  }, [flow, onCapture]);

  return null;
}

describe('OnboardingFlowProvider account-bound resume state', () => {
  let currentUser: { id: string } | null;

  beforeEach(async () => {
    jest.clearAllMocks();
    currentUser = { id: 'user-a' };
    mockedUseAuth.mockImplementation(() => ({ user: currentUser, isLoading: false } as never));
    await patchOnboardingDraft({
      ownerUserId: 'user-a',
      step: 'paywall',
      paywallMode: 'new-owner',
      committedFamilyId: 'family-a',
      captureCommitted: false,
    });
  });

  it('keeps a same-account paywall draft but clears it for a different account', async () => {
    let latest: ReturnType<typeof useOnboardingFlow> | null = null;
    const onCapture = (flow: ReturnType<typeof useOnboardingFlow>) => {
      latest = flow;
    };
    const screen = render(
      <OnboardingFlowProvider>
        <Probe onCapture={onCapture} />
      </OnboardingFlowProvider>,
    );

    await waitFor(() => {
      expect(latest?.isHydrated).toBe(true);
      expect(latest?.draft.ownerUserId).toBe('user-a');
      expect(latest?.draft.committedFamilyId).toBe('family-a');
    });

    currentUser = { id: 'user-b' };
    await act(async () => {
      screen.rerender(
        <OnboardingFlowProvider>
          <Probe onCapture={onCapture} />
        </OnboardingFlowProvider>,
      );
    });

    await waitFor(() => {
      expect(latest?.isHydrated).toBe(true);
      expect(latest?.draft.ownerUserId).toBeUndefined();
      expect(latest?.draft.committedFamilyId).toBeUndefined();
    });
    expect(await getOnboardingDraft()).toBeNull();

    screen.unmount();
  });

  it('hides an account-bound draft while signed out without overwriting its resume marker', async () => {
    currentUser = null;
    let latest: ReturnType<typeof useOnboardingFlow> | null = null;
    const onCapture = (flow: ReturnType<typeof useOnboardingFlow>) => {
      latest = flow;
    };
    const screen = render(
      <OnboardingFlowProvider>
        <Probe onCapture={onCapture} />
      </OnboardingFlowProvider>,
    );

    await waitFor(() => {
      expect(latest?.isHydrated).toBe(true);
      expect(latest?.draft.ownerUserId).toBeUndefined();
      expect(latest?.draft.committedFamilyId).toBeUndefined();
    });
    expect((await getOnboardingDraft())?.ownerUserId).toBe('user-a');
    expect((await getOnboardingDraft())?.committedFamilyId).toBe('family-a');

    currentUser = { id: 'user-a' };
    await act(async () => {
      screen.rerender(
        <OnboardingFlowProvider>
          <Probe onCapture={onCapture} />
        </OnboardingFlowProvider>,
      );
    });

    await waitFor(() => {
      expect(latest?.isHydrated).toBe(true);
      expect(latest?.draft.ownerUserId).toBe('user-a');
      expect(latest?.draft.committedFamilyId).toBe('family-a');
    });

    screen.unmount();
  });

  it('signing in over the device\'s own pre-auth draft never drops back to the unhydrated gate', async () => {
    // A fresh pre-auth draft (no account yet), exactly what S12B holds when
    // the OTP verifies.
    await patchOnboardingDraft({
      ownerUserId: undefined,
      committedFamilyId: undefined,
      paywallMode: undefined,
      step: 'code',
      kidNames: ['Lila'],
    });
    currentUser = null;
    const hydratedStates: boolean[] = [];
    let latest: ReturnType<typeof useOnboardingFlow> | null = null;
    const onCapture = (flow: ReturnType<typeof useOnboardingFlow>) => {
      latest = flow;
      hydratedStates.push(flow.isHydrated);
    };
    const screen = render(
      <OnboardingFlowProvider>
        <Probe onCapture={onCapture} />
      </OnboardingFlowProvider>,
    );

    await waitFor(() => expect(latest?.isHydrated).toBe(true));
    const firstHydratedIndex = hydratedStates.indexOf(true);

    currentUser = { id: 'user-a' };
    await act(async () => {
      screen.rerender(
        <OnboardingFlowProvider>
          <Probe onCapture={onCapture} />
        </OnboardingFlowProvider>,
      );
    });

    // Once hydrated, the sign-in must not flip it back -- the layout would
    // swap its Stack for a spinner and remount at S0.
    expect(hydratedStates.slice(firstHydratedIndex)).not.toContain(false);
    expect(latest?.draft.step).toBe('code');
    expect(latest?.draft.kidNames).toEqual(['Lila']);

    screen.unmount();
  });
});
