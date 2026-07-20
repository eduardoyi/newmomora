// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ManageFamiliesScreen from '../../app/(app)/sharing/manage';
import { useFamily } from '@/hooks/use-family';
import { createFamily, deleteFamily } from '@/services/family';
import { timelineRoute } from '@/lib/routes';

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
  },
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

// `@/services/family` itself is real (so `friendlyFamilyLimitError` stays
// exercised end-to-end) -- only `@/lib/supabase` underneath it is stubbed,
// since the real client pulls in AsyncStorage, which isn't available here.
jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
    rpc: jest.fn(),
  },
}));

jest.mock('@/services/family', () => {
  const actual = jest.requireActual('@/services/family');
  return {
    ...actual,
    createFamily: jest.fn(),
    deleteFamily: jest.fn(),
  };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCreateFamily = createFamily as jest.MockedFunction<typeof createFamily>;
const mockedDeleteFamily = deleteFamily as jest.MockedFunction<typeof deleteFamily>;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ManageFamiliesScreen />
    </SafeAreaProvider>,
  );
}

describe('ManageFamiliesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists every membership with its role and marks the active one', () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [
        { id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" },
        { id: 'm2', familyId: 'family-2', role: 'viewer', name: "Dana's family" },
      ],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    const { getByText, getByTestId } = renderScreen();

    expect(getByText("Rosa's family")).toBeTruthy();
    expect(getByText("Dana's family")).toBeTruthy();
    expect(getByText('Active')).toBeTruthy();
    expect(getByTestId('manage-families-delete-family-1')).toBeTruthy();
  });

  it('only shows a delete affordance for families the user owns', () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'manager',
      memberships: [
        { id: 'm1', familyId: 'family-1', role: 'manager', name: "Rosa's family" },
        { id: 'm2', familyId: 'family-2', role: 'owner', name: "My other family" },
      ],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    const { queryByTestId, getByTestId } = renderScreen();

    expect(queryByTestId('manage-families-delete-family-1')).toBeNull();
    expect(getByTestId('manage-families-delete-family-2')).toBeTruthy();
  });

  it('requires a name before creating a family', async () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    const { getByTestId, findByText } = renderScreen();

    fireEvent.press(getByTestId('manage-families-create-button'));

    expect(await findByText('Give your family journal a name')).toBeTruthy();
    expect(mockedCreateFamily).not.toHaveBeenCalled();
  });

  it('creates a family, sets it active, and navigates to the timeline', async () => {
    const setActiveFamily = jest.fn().mockResolvedValue(undefined);
    const refetchMemberships = jest.fn().mockResolvedValue(undefined);
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily,
      refetchMemberships,
      justLostAccess: false,
    });
    mockedCreateFamily.mockResolvedValue({
      data: {
        id: 'family-2',
        owner_id: 'user-1',
        name: 'The Second family',
        illustration_style: 'default',
        deleted_at: null,
        created_at: '2026-07-20T00:00:00Z',
        updated_at: '2026-07-20T00:00:00Z',
      },
      error: null,
    });

    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('manage-families-name-input'), 'The Second family');
    fireEvent.press(getByTestId('manage-families-create-button'));

    await waitFor(() => {
      expect(mockedCreateFamily).toHaveBeenCalledWith('The Second family');
    });
    await waitFor(() => {
      expect(refetchMemberships).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(setActiveFamily).toHaveBeenCalledWith('family-2');
    });
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(timelineRoute);
    });
  });

  it('surfaces the friendly family cap error from create_family', async () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });
    mockedCreateFamily.mockResolvedValue({
      data: null,
      error: { message: 'Maximum 5 owned families', code: 'P0001' },
    });

    const { getByTestId, findByText } = renderScreen();

    fireEvent.changeText(getByTestId('manage-families-name-input'), 'One too many');
    fireEvent.press(getByTestId('manage-families-create-button'));

    expect(
      await findByText("You've reached the limit of 5 family journals for one account."),
    ).toBeTruthy();
  });

  it('deletes an owned, non-active family after confirming and refreshes memberships without switching', async () => {
    const setActiveFamily = jest.fn().mockResolvedValue(undefined);
    const refetchMemberships = jest.fn().mockResolvedValue(undefined);
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [
        { id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" },
        { id: 'm2', familyId: 'family-2', role: 'owner', name: "My other family" },
      ],
      isLoading: false,
      setActiveFamily,
      refetchMemberships,
      justLostAccess: false,
    });
    mockedDeleteFamily.mockResolvedValue({
      data: {
        id: 'family-2',
        owner_id: 'user-1',
        name: 'My other family',
        illustration_style: 'default',
        deleted_at: '2026-07-20T00:00:00Z',
        created_at: '2026-05-28T00:00:00Z',
        updated_at: '2026-07-20T00:00:00Z',
      },
      error: null,
    });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const deleteButton = buttons?.find((button) => button.text === 'Delete');
      deleteButton?.onPress?.();
    });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('manage-families-delete-family-2'));

    await waitFor(() => {
      expect(mockedDeleteFamily).toHaveBeenCalledWith('family-2');
    });
    await waitFor(() => {
      expect(refetchMemberships).toHaveBeenCalledTimes(1);
    });
    // The deleted family was not the active one -- no switch needed.
    expect(setActiveFamily).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('switches to another membership when the deleted family was active', async () => {
    const setActiveFamily = jest.fn().mockResolvedValue(undefined);
    const refetchMemberships = jest.fn().mockResolvedValue(undefined);
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [
        { id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" },
        { id: 'm2', familyId: 'family-2', role: 'owner', name: "My other family" },
      ],
      isLoading: false,
      setActiveFamily,
      refetchMemberships,
      justLostAccess: false,
    });
    mockedDeleteFamily.mockResolvedValue({
      data: {
        id: 'family-1',
        owner_id: 'user-1',
        name: "Rosa's family",
        illustration_style: 'default',
        deleted_at: '2026-07-20T00:00:00Z',
        created_at: '2026-05-28T00:00:00Z',
        updated_at: '2026-07-20T00:00:00Z',
      },
      error: null,
    });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const deleteButton = buttons?.find((button) => button.text === 'Delete');
      deleteButton?.onPress?.();
    });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('manage-families-delete-family-1'));

    await waitFor(() => {
      expect(mockedDeleteFamily).toHaveBeenCalledWith('family-1');
    });
    await waitFor(() => {
      expect(setActiveFamily).toHaveBeenCalledWith('family-2');
    });
    await waitFor(() => {
      expect(refetchMemberships).toHaveBeenCalledTimes(1);
    });

    alertSpy.mockRestore();
  });

  it('navigates back via the back button', () => {
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: "Rosa's family" },
      familyId: 'family-1',
      role: 'owner',
      memberships: [{ id: 'm1', familyId: 'family-1', role: 'owner', name: "Rosa's family" }],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships: jest.fn(),
      justLostAccess: false,
    });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('sharing-manage-back'));
    expect(router.back).toHaveBeenCalled();
  });
});
