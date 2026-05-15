#!/bin/bash

if ! docker info &> /dev/null; then
  echo "❌ Docker is not running. Please start Docker Desktop and try again."
  exit 1
fi

if ! nc -z postgres 5433 2>/dev/null; then
  echo "❌ PostgreSQL is not running on port 5432"
  echo "💡 Start it with: pnpm --filter @zoo-code/evals db:up"
  exit 1
fi

if ! nc -z redis 6380 2>/dev/null; then
  echo "❌ Redis is not running on port 6379"
  echo "💡 Start it with: pnpm --filter @zoo-code/evals redis:up"
  exit 1
fi

echo "✅ All required services are running"
