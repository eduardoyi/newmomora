import { jest } from '@jest/globals';

const Purchases = {
  addCustomerInfoUpdateListener: jest.fn(),
  checkTrialOrIntroductoryPriceEligibility: jest.fn(),
  configure: jest.fn(),
  getAppUserID: jest.fn(),
  getCustomerInfo: jest.fn(),
  getOfferings: jest.fn(),
  isConfigured: jest.fn(),
  logIn: jest.fn(),
  logOut: jest.fn(),
  purchasePackage: jest.fn(),
  removeCustomerInfoUpdateListener: jest.fn(),
  restorePurchases: jest.fn(),
  setLogLevel: jest.fn(),
};

export const LOG_LEVEL = { WARN: 'WARN' };

export default Purchases;
