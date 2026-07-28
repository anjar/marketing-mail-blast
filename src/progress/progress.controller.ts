import { Controller, Get, Param } from '@nestjs/common';
import { ProgressService, CampaignProgress } from './progress.service';

@Controller('api/campaigns')
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  /**
   * GET /api/campaigns/:id/progress — latest persisted progress (200) or 404.
   * All counts are PostgreSQL-derived; invariant total = pending + rejected +
   * sent + failed + deliveryUnknown holds (FR-029).
   */
  @Get(':id/progress')
  async get(@Param('id') id: string): Promise<CampaignProgress> {
    return this.progress.getProgress(id);
  }
}
