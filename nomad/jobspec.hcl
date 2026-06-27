# Bottega — Nomad service job (homelab cluster).
#
# ONE parametric spec serves both environments. The two deployments are kept
# apart by Nomad NAMESPACE (prod / dev), because HCL2 forbids interpolating the
# job block label, so the job id is the literal "bottega" in both namespaces.
# CI passes the per-environment differences as -var flags + -namespace:
#
#   prod (semver tag): -namespace prod -var instance=bottega \
#                      -var app_host=bottega.cobus.dev
#   dev  (main push):  -namespace dev  -var instance=bottega-dev \
#                      -var app_host=bottega-dev.cobus.dev
#
# Provisioned in the HOMELAB repo, not here (deploy fails if missing — flag,
# don't invent): the Nomad namespaces `prod`/`dev`; the host volumes named
# `bottega` and `bottega-dev`; the Vault roles `bottega`/`bottega-dev`; and the
# KV-v2 secret paths `secret/bottega/app` + `secret/bottega-dev/app`.

variable "image_tag" {
  type        = string
  description = "Image tag to deploy — the git SHA CI just built and pushed."
}

variable "instance" {
  type        = string
  description = "Environment instance name: drives the host volume, Vault role, secret path, and service/router names. `bottega` (prod) or `bottega-dev` (dev)."
}

variable "app_host" {
  type        = string
  description = "Public FQDN for Traefik routing, e.g. bottega.cobus.dev."
}

job "bottega" {
  datacenters = ["homelab"]
  type        = "service"

  group "web" {
    count = 1

    network {
      port "http" {
        to = 3001
      }
    }

    # Persistent, writable state. REQUIRED because the task runs read-only-root
    # (below) and bottega is stateful: SQLite DB (+WAL/SHM), per-user Claude
    # OAuth tokens, task markdown under $HOME/.bottega, and git worktrees all
    # live here. Source is the per-env host volume registered in the homelab repo.
    volume "data" {
      type      = "host"
      source    = var.instance
      read_only = false
    }

    service {
      name = var.instance
      port = "http"

      tags = [
        "traefik.enable=true",
        "traefik.http.routers.${var.instance}.rule=Host(`${var.app_host}`)",
        "traefik.http.routers.${var.instance}.entrypoints=websecure",
        "traefik.http.routers.${var.instance}.tls=true",
        "traefik.http.routers.${var.instance}.tls.certresolver=cobus-dev",
      ]

      # Bottega exposes /health (public, pre-auth) — NOT /api/health.
      check {
        type     = "http"
        path     = "/health"
        interval = "10s"
        timeout  = "2s"
      }
    }

    task "web" {
      driver = "docker"

      # Authenticate to Vault for the secret template below. The role grants read
      # on this instance's secret path only (least privilege per environment).
      vault {
        role = var.instance
      }

      config {
        image           = "ghcr.io/cobusbernard/bottega:${var.image_tag}"
        ports           = ["http"]
        readonly_rootfs = true

        # Read-only root => /tmp must be a writable tmpfs (git, node-pty, ffmpeg,
        # and assorted tooling scribble here). Everything persistent goes to /data.
        mount {
          type   = "tmpfs"
          target = "/tmp"
          tmpfs_options {
            size = 268435456 # 256 MiB
          }
        }
      }

      volume_mount {
        volume      = "data"
        destination = "/data"
        read_only   = false
      }

      # ---- Non-secret config (hardcoded, safe in git) -----------------------
      # Names match .env.example EXACTLY so the app's config layer is identical
      # locally and when deployed; only the source differs.
      env {
        NODE_ENV = "production"
        PORT     = "3001"

        # Stateful paths relocated onto the writable /data volume so they survive
        # reschedules and the read-only root filesystem. HOME on /data also puts
        # ~/.bottega (task markdown), the Claude SDK JSONL, and git/gh/CLI config
        # on the volume — os.homedir() honors $HOME, so no path escapes to the
        # read-only root.
        DATABASE_PATH      = "/data/bottega.db" # SQLite (metadata + transcripts)
        CLAUDE_CONFIG_ROOT = "/data/users"      # per-user Claude OAuth tokens
        HOME               = "/data/home"
      }

      # ---- Secrets from Vault (NEVER hardcoded) -----------------------------
      # Rendered into an env file Nomad loads as container env vars. Inside the
      # template, KV-v2 uses the raw API path `secret/data/<instance>/app` and
      # reads fields via `.Data.data.<field>` (the Vault CLI addresses the same
      # secret as `secret/<instance>/app`, without `data/`).
      template {
        destination = "secrets/bottega.env"
        env         = true
        change_mode = "restart" # restart the task when these secrets rotate
        data        = <<-EOH
{{ with secret "secret/data/${var.instance}/app" }}
JWT_SECRET={{ .Data.data.jwt_secret }}
GITHUB_WEBHOOK_SECRET={{ .Data.data.github_webhook_secret }}
{{ end }}
EOH
      }

      # Bottega spawns Claude SDK subprocesses, node-pty, ffmpeg and git, so it
      # needs more headroom than a plain API. Starting point — tune in the homelab repo.
      resources {
        cpu    = 1000 # MHz
        memory = 2048 # MB
      }
    }
  }
}
