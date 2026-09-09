import { NextResponse } from 'next/server';

import { TEACHER_COOKIE } from '@/lib/server/teacher-auth';

export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(TEACHER_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
