# Deploying PaperLens to AWS Elastic Beanstalk (free tier)

Target: **one `t3.micro` instance, Docker platform, no load balancer.**
The classic/application load balancer is *not* in the free tier — `eb create --single`
avoids it by putting the instance directly behind its own public IP. We deploy from a
source bundle (EB zips this directory and builds the Dockerfile on the instance), so
no ECR registry and no registry storage cost.

## 0. Prerequisites

```bash
pip install awsebcli
aws configure   # access key, secret, default region — needs an IAM user, not root
```

Free-tier note: accounts created before mid-2024 get 750 h/month of `t3.micro` for
12 months. Newer accounts are on the credit-based free plan — check
**Billing → Free tier** in the console so you know which one you have before creating
resources.

## 1. `eb init`

From the `paperlens/` directory (the one containing the Dockerfile):

```bash
eb init paperlens --platform docker --region ap-south-1
```

- Pick the region closest to you/your graders (`ap-south-1` = Mumbai).
- This writes `.elasticbeanstalk/config.yml` (committed) and nothing else.
- Answer **No** to CodeCommit and SSH unless you want instance SSH access.

## 2. Create the environment — single instance, t3.micro

```bash
eb create paperlens-env --single --instance-types t3.micro --timeout 20
```

- `--single`: no load balancer — the whole point of the free-tier design.
- `--timeout 20`: the instance builds the Docker image itself (pip installs
  torch + sentence-transformers on 1 vCPU), which can exceed the default
  10-minute wait. The build only happens on deploys, not restarts.
- The environment will initially show **degraded/red** because the app
  fails fast without `ANTHROPIC_API_KEY` — that is deliberate. Fix it in step 3.

If the build fails with a disk-space error, raise the root volume:
`eb create ... --envvars ...` won't do it; instead add
`option_settings` for `aws:autoscaling:launchconfiguration RootVolumeSize=16`
via `.ebextensions/` — usually unnecessary, the default 8 GB fits this image.

## 3. Set the API key as an EB environment property

```bash
eb setenv GEMINI_API_KEY=your-ai-studio-key
```

- Create the key at https://aistudio.google.com/apikey **without linking a
  billing account** — that keeps the Gemini side of the project at a hard $0:
  exceeding free-tier rate limits returns HTTP 429 (which the app retries
  with backoff), it never bills.
- Stored by the EB service and injected into the container environment —
  **never** in the source bundle, never in git.
- Caveat: the key touches your shell history. Clear it afterwards
  (`Clear-History` in PowerShell, `history -d` in bash), or set it in the EB
  console instead: *Environment → Configuration → Updates, monitoring, and
  logging → Environment properties*.

The environment restarts and should go **green**. Verify:

```bash
eb status     # Health: Green
eb open       # opens the public URL in a browser
```

## 4. The public URL (and the HTTPS caveat — be honest in the demo)

`eb status` shows the CNAME, e.g.
`http://paperlens-env.eba-xxxx.ap-south-1.elasticbeanstalk.com`.

**A single-instance environment serves plain HTTP.** Free-tier HTTPS normally
comes from an ALB + ACM certificate — which we deliberately avoided. If the
rubric strictly requires an `https://` URL, put **CloudFront** (always-free
tier: 1 TB/month egress) in front:

1. CloudFront console → *Create distribution*.
2. Origin domain: the EB CNAME. Origin protocol: **HTTP only**.
3. Viewer protocol policy: *Redirect HTTP to HTTPS*.
4. Cache policy: **CachingDisabled**; origin request policy: **AllViewerExceptHostHeader**
   (the app streams SSE and every request is dynamic — caching would break it).
5. Use the issued `https://dxxxx.cloudfront.net` URL for grading.

This stays free and adds TLS termination without touching the instance.

## 5. Budget alert at $1

Console → **Billing and Cost Management → Budgets → Create budget**:

1. *Use a template* → **Monthly cost budget**.
2. Amount: **$1**. Email: your address. Create.

You'll get an email at 85% and 100% of $1 actual spend. (CLI equivalent exists
via `aws budgets create-budget`, but the console template is two clicks.)

## 6. Redeploying changes

```bash
eb deploy --timeout 20
```

Remember: a deploy restarts the container, which **clears the in-memory index**
— re-upload the PDF afterwards. (Known limitation, documented in the README.)

## 7. Tear down after grading

```bash
eb terminate paperlens-env
```

Confirms and deletes the instance, security group, and CloudWatch alarms.
Also delete the CloudFront distribution (disable → delete) if you created one,
and optionally the EB S3 bundle bucket (`elasticbeanstalk-<region>-<acct>`).
Check **Billing → Bills** a day later to confirm $0 accruing.
