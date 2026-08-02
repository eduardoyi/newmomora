import { jest } from '@jest/globals';

// The mocked PostHog client instance. `src/services/analytics.ts` creates
// exactly one instance via `new PostHog(...)`, and every constructor call
// returns this same object so tests can assert against it directly:
//   import { mockPostHogClient } from 'posthog-react-native';
export const mockPostHogClient = {
  capture: jest.fn(),
  identify: jest.fn(),
  register: jest.fn(() => Promise.resolve()),
  setPersonProperties: jest.fn(),
  reset: jest.fn(),
};

const PostHog = jest.fn().mockImplementation(() => mockPostHogClient);

export default PostHog;
