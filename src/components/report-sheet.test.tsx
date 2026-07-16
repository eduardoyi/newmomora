import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { getReportKeyboardAvoidingBehavior, ReportSheet } from '@/components/report-sheet';

function renderSheet(targetType: 'comment' | 'memory_illustration' = 'comment') {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const view = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ReportSheet
        isSubmitting={false}
        onClose={jest.fn()}
        onSubmit={onSubmit}
        targetLabel="comment"
        targetType={targetType}
        visible
      />
    </SafeAreaProvider>,
  );
  return { ...view, onSubmit };
}

describe('ReportSheet', () => {
  it('keeps the optional lower note keyboard-safe and warns against child data', () => {
    const { getByTestId, getByText } = renderSheet();

    expect(getReportKeyboardAvoidingBehavior('ios')).toBe('padding');
    expect(getReportKeyboardAvoidingBehavior('android')).toBe('height');
    expect(getByTestId('report-note').props.multiline).toBe(true);
    expect(getByTestId('report-note').props.maxLength).toBe(500);
    expect(getByText('Don’t include journal text, child names, or photos.')).toBeTruthy();
    expect(getByTestId('report-submit')).toBeTruthy();
  });

  it('shows the AI-depiction reason only for generated visuals', () => {
    expect(renderSheet('comment').queryByTestId('report-reason-misleading_ai_depiction')).toBeNull();
    expect(renderSheet('memory_illustration').getByTestId('report-reason-misleading_ai_depiction')).toBeTruthy();
  });

  it('submits the selected controlled reason and bounded note', async () => {
    const { getByTestId, onSubmit } = renderSheet();
    fireEvent.press(getByTestId('report-reason-privacy'));
    fireEvent.changeText(getByTestId('report-note'), 'A small amount of context');
    fireEvent.press(getByTestId('report-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('privacy', 'A small amount of context'));
  });
});
