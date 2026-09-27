module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/demo_service'],
  testMatch: ['<rootDir>/demo_service/tests/**/*.test.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dashboard'],
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/shared/$1',
  },
};
