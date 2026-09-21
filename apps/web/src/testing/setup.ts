import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// The defaults (1 s to find an element, 5 s per test) are tuned for an idle machine. Typing into a
// form with user-event and waiting for a rendered result is slow on a busy CI runner or a laptop
// running other things, and a slow run must not read as a failure.
configure({ asyncUtilTimeout: 5000 });
