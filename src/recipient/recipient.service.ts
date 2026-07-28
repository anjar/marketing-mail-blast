import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface SourceRecipientRow {
  id: bigint;
  email: string | null;
  name: string | null;
}

/**
 * Read-only access to the reusable source recipient dataset. The dataset is
 * never modified through the application in this phase (FR-005).
 */
@Injectable()
export class RecipientService {
  constructor(private readonly prisma: PrismaService) {}

  /** Highest eligible recipient id — the stable snapshot upper bound (FR-004). */
  async maxRecipientId(): Promise<bigint> {
    const row = await this.prisma.recipient.aggregate({ _max: { id: true } });
    return row._max.id ?? 0n;
  }

  /**
   * Keyset page of source recipients within the snapshot: id > cursor AND
   * id <= snapshotMax, ascending, bounded by batchSize. Never deep OFFSET; never
   * loads the whole dataset (FR-037, FR-040).
   */
  async keysetPage(
    cursor: bigint,
    snapshotMax: bigint,
    batchSize: number,
  ): Promise<SourceRecipientRow[]> {
    return this.prisma.recipient.findMany({
      where: { id: { gt: cursor, lte: snapshotMax } },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, email: true, name: true },
    });
  }
}
