'use client';

import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';

export default function OrgError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="space-y-4">
      <Alert>We could not load this page. Please try again.</Alert>
      <Button variant="secondary" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
