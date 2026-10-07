import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/app';

describe('HealthController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/attendance/health responds 200 with a healthy payload', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/attendance/health'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'attendance-service',
    });
  });
});
