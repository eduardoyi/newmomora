import { render } from '@testing-library/react-native';

import { StubTear } from './stub-tear';

describe('StubTear', () => {
  it('renders without crashing', () => {
    const { getByTestId } = render(<StubTear testID="stub-tear" />);
    expect(getByTestId('stub-tear')).toBeTruthy();
  });

  it('accepts a custom card color for the punched notches without crashing', () => {
    const { getByTestId } = render(<StubTear cardColor="#F2EFF8" testID="stub-tear" />);
    expect(getByTestId('stub-tear')).toBeTruthy();
  });
});
