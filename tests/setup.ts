import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// globals を使わない構成でも React Testing Library の後始末を必ず行う。
afterEach(() => {
  cleanup()
})
