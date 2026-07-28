import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { CampaignService } from './campaign.service';

@Controller('api/campaigns')
export class CampaignController {
  constructor(private readonly campaigns: CampaignService) {}

  /**
   * POST /api/campaigns — submit one campaign.
   * 201 created / 400 validation / 409 another campaign active (deterministic).
   * Processing starts immediately; no second confirmation step (FR-003).
   */
  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateCampaignDto) {
    return this.campaigns.create(dto.subject.trim(), dto.body);
  }

  /**
   * GET /api/campaigns/active — current active campaign, or 204 when none.
   */
  @Get('active')
  async active(@Res() res: Response): Promise<void> {
    const summary = await this.campaigns.getActive();
    if (!summary) {
      res.status(204).send();
      return;
    }
    res.status(200).json(summary);
  }
}
