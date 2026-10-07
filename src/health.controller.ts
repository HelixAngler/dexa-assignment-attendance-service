import { Controller, Get } from '@nestjs/common';

export type HealthPayload = {
  status: 'ok';
  service: 'attendance-service';
};

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthPayload {
    return { status: 'ok', service: 'attendance-service' };
  }
}
