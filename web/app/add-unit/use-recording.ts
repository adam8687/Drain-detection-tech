'use client';

import { useEffect, useState } from 'react';
import { DrainApiError } from '../../lib/api';
import type { DrainApi, RecordView } from '../../lib/api';

export function useRecording(api: DrainApi, recordId: string | null) {
  const [view, setView] = useState<RecordView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setView(null); setError('');
    if (!recordId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if(document.hidden){timer=setTimeout(load,1000);return;}
      try {
        const next = await api.record(recordId, null, controller.signal);
        if (controller.signal.aborted) return;
        setView(next); setError('');
        if (next.record.recording_status === 'recording') timer = setTimeout(load, 1500);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof DrainApiError && err.status===401 ? 'Please sign in again to continue setup.' : 'We could not connect to your unit. Try again, or contact your installer.');
        timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, recordId]);
  return { view, error };
}
