import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { getMyAiUsageLimitNotices, usageLimitMessage } from '@/services/usage-limits';

export function useAiUsageLimitNotices(): void {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const query = useQuery({
    queryKey: ['ai-usage-limit-notices', user?.id, familyId],
    queryFn: () => getMyAiUsageLimitNotices(familyId!),
    enabled: Boolean(user && familyId),
    staleTime: 30_000,
  });

  const isPresenting = useRef(false);
  const generationRef = useRef(0);
  const [presentationRevision, setPresentationRevision] = useState(0);
  useEffect(() => {
    generationRef.current += 1;
    isPresenting.current = false;
    return () => {
      generationRef.current += 1;
      isPresenting.current = false;
    };
  }, [familyId, user?.id]);
  useEffect(() => {
    if (!user || !familyId || !query.data) return;
    if (isPresenting.current) return;
    const notices = [...query.data].sort((a, b) => b.retry_after.localeCompare(a.retry_after));
    const generation = generationRef.current;
    let cancelled = false;
    void (async () => {
      for (const notice of notices) {
        if (cancelled || generation !== generationRef.current) return;
        const key = `ai-usage-limit-notice:${user.id}:${familyId}:${notice.target_kind}:${notice.target_id}:${notice.scope}:${notice.quota_policy_epoch}:${notice.retry_after}`;
        if (await AsyncStorage.getItem(key)) continue;
        if (cancelled || generation !== generationRef.current) return;
        isPresenting.current = true;
        await AsyncStorage.setItem(key, 'shown');
        if (cancelled || generation !== generationRef.current) return;
        Alert.alert('A little pause for illustrations', usageLimitMessage(notice.target_kind, notice.retry_after), [{ text: 'Okay', onPress: () => {
          if (generation !== generationRef.current) return;
          isPresenting.current = false;
          setPresentationRevision((current) => current + 1);
        } }], { cancelable: false });
        return;
      }
    })();
    return () => { cancelled = true; };
  }, [familyId, presentationRevision, query.data, user]);
}
