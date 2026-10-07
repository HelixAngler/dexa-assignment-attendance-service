import { Controller, Get, INestApplication, Module, NotFoundException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';

import { createApp } from '../src/app';
import { AppException } from '../src/common/app.exception';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';

@Controller('boom')
class BoomController {
  @Get('auth-required')
  authRequired(): void {
    throw new AppException(401, 'AUTH_REQUIRED');
  }

  @Get('attempts')
  attempts(): void {
    throw new AppException(401, 'AUTH_INVALID', { attemptsRemaining: 3 });
  }

  @Get('already-open')
  alreadyOpen(): void {
    throw new AppException(409, 'SESSION_ALREADY_OPEN');
  }

  @Get('internal')
  internal(): void {
    throw new Error('boom: connection refused for postgres://admin:secret@db');
  }

  @Get('missing')
  missing(): void {
    throw new NotFoundException('internal path /srv/private/keys');
  }

  @Get('ok')
  ok(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [BoomController] })
class BoomModule {}

describe('HttpExceptionFilter', () => {
  let app: INestApplication;
  let consoleError: jest.SpyInstance;

  beforeAll(async () => {
    app = await NestFactory.create(BoomModule, { logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  afterAll(async () => {
    await app.close();
  });

  it('leaves successful responses untouched', async () => {
    const response = await request(app.getHttpServer()).get('/boom/ok');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  it('defaults to Indonesian and emits exactly statusCode, code and message', async () => {
    const response = await request(app.getHttpServer()).get('/boom/already-open');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      code: 'SESSION_ALREADY_OPEN',
      message: 'Anda sudah absen masuk dan sesi masih berbuka. Silakan absen pulang terlebih dahulu.',
    });
    expect(Object.keys(response.body).sort()).toEqual([
      'code',
      'message',
      'statusCode',
    ]);
  });

  it('localizes the message with Accept-Language: en', async () => {
    const response = await request(app.getHttpServer())
      .get('/boom/already-open')
      .set('Accept-Language', 'en');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      code: 'SESSION_ALREADY_OPEN',
      message:
        'You already have an open attendance session. Please clock out first.',
    });
  });

  it('parses a regional English header loosely', async () => {
    const response = await request(app.getHttpServer())
      .get('/boom/auth-required')
      .set('Accept-Language', 'en-GB,en;q=0.9');

    expect(response.status).toBe(401);
    expect(response.body.message).toBe(
      'You are not signed in. Please sign in first.'
    );
  });

  it('falls back to Indonesian for an unsupported language', async () => {
    const response = await request(app.getHttpServer())
      .get('/boom/auth-required')
      .set('Accept-Language', 'fr-FR,fr;q=0.9');

    expect(response.status).toBe(401);
    expect(response.body.message).toBe(
      'Sesi Anda belum terautentikasi. Silakan masuk terlebih dahulu.'
    );
  });

  it('merges AppException details into the body without extra fields', async () => {
    const response = await request(app.getHttpServer())
      .get('/boom/attempts')
      .set('Accept-Language', 'en');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: 'AUTH_INVALID',
      message: 'Email or password is incorrect.',
      attemptsRemaining: 3,
    });
  });

  it('collapses an unknown throwable into a generic 500 INTERNAL in Indonesian', async () => {
    const response = await request(app.getHttpServer()).get('/boom/internal');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL',
      message: 'Terjadi kesalahan di server. Silakan coba lagi nanti.',
    });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('postgres');
    expect(consoleError).toHaveBeenCalled();
  });

  it('localizes the generic 500 message too', async () => {
    const response = await request(app.getHttpServer())
      .get('/boom/internal')
      .set('Accept-Language', 'en');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: 'INTERNAL',
      message: 'Something went wrong on the server. Please try again later.',
    });
  });

  it('renders a 404 as NOT_FOUND with a localized message', async () => {
    const response = await request(app.getHttpServer()).get('/boom/missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Data yang diminta tidak ditemukan.',
    });
    expect(JSON.stringify(response.body)).not.toContain('/srv/private/keys');
  });

  it('localizes the 404 message in English', async () => {
    const response = await request(app.getHttpServer())
      .get('/boom/missing')
      .set('Accept-Language', 'en');

    expect(response.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'The requested data was not found.',
    });
  });
});

describe('createApp global registration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps the health payload as-is', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/attendance/health'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'attendance-service',
    });
  });

  it('answers an unknown route with the standard error shape in Indonesian', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/attendance/does-not-exist'
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'Data yang diminta tidak ditemukan.',
    });
    expect(Object.keys(response.body).sort()).toEqual([
      'code',
      'message',
      'statusCode',
    ]);
  });

  it('localizes the unknown-route 404 in English', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/attendance/does-not-exist')
      .set('Accept-Language', 'en');

    expect(response.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'The requested data was not found.',
    });
  });
});
