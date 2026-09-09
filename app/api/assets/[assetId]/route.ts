import { NextRequest, NextResponse } from 'next/server';

import {
  getCourseAsset,
  getCourseAssetBytes,
  getCourseAssetSlice,
} from '@/lib/server/courseware/asset-repo';
import { parseRangeHeader } from '@/lib/server/http-range';
import { createLogger } from '@/lib/logger';

const log = createLogger('CourseAssets');

const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=86400, immutable' } as const;

/** Bytes live in PostgreSQL (`course_assets.byte_data`), not on disk. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  try {
    const record = await getCourseAsset(assetId);
    if (!record) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const total = record.sizeBytes ?? 0;
    const contentType = record.mimeType || 'application/octet-stream';
    const range = parseRangeHeader(req.headers.get('range'), total);

    if (range.kind === 'unsatisfiable') {
      // Never cache a range error: an immutable 416 would poison the media URL.
      return new NextResponse(null, {
        status: 416,
        headers: { 'Cache-Control': 'no-store', 'Content-Range': `bytes */${total}` },
      });
    }

    if (range.kind === 'range') {
      const bytes = await getCourseAssetSlice(assetId, range.start, range.end - range.start + 1);
      if (!bytes) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return new NextResponse(new Uint8Array(bytes), {
        status: 206,
        headers: {
          ...CACHE_HEADERS,
          'Content-Type': contentType,
          'Content-Length': String(bytes.byteLength),
          'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const bytes = await getCourseAssetBytes(assetId);
    if (!bytes) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...CACHE_HEADERS,
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (error) {
    log.error(`Asset serving failed [assetId=${assetId}]:`, error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
