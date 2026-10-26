Terraform will perform the following actions:

  # aws_s3_bucket.app will be created
  + resource "aws_s3_bucket" "app" {
      + arn = (known after apply)
      + bucket = "my-app-bucket-12345"
      + bucket_domain_name = (known after apply)
      + bucket_regional_domain_name = (known after apply)
      + id = (known after apply)
      + tags = {
          + "Environment" = "production"
          + "Name" = "app-data"
        }
    }

  # aws_s3_bucket_public_access_block.app will be created
  + resource "aws_s3_bucket_public_access_block" "app" {
      + block_public_acls = true
      + block_public_policy = true
      + bucket = (known after apply)
      + id = (known after apply)
      + ignore_public_acls = true
      + restrict_public_buckets = true
    }

  # aws_s3_bucket_server_side_encryption_configuration.app will be created
  + resource "aws_s3_bucket_server_side_encryption_configuration" "app" {
      + bucket = (known after apply)
      + id = (known after apply)

      + rule {
          + apply_server_side_encryption_by_default {
              + sse_algorithm = "AES256"
            }
        }
    }

  # aws_ec2_security_group.app will be created
  + resource "aws_security_group" "app" {
      + arn = (known after apply)
      + description = "Application security group"
      + egress = [
          + {
              + cidr_blocks = [
                  + "10.0.0.0/8",
                ]
              + description = "Allow outbound to internal network only"
              + from_port = 0
              + ipv6_cidr_blocks = []
              + prefix_list_ids = []
              + protocol = "-1"
              + security_groups = []
              + self = false
              + to_port = 0
            },
      ]
      + id = (known after apply)
      + ingress = [
          + {
              + cidr_blocks = [
                  + "10.0.0.0/8",
                ]
              + description = "HTTPS from internal network only"
              + from_port = 443
              + ipv6_cidr_blocks = []
              + prefix_list_ids = []
              + protocol = "tcp"
              + security_groups = []
              + self = false
              + to_port = 443
            },
        ]
      + name = "app-sg"
      + owner_id = (known after apply)
      + tags = {
          + "Name" = "app-security-group"
        }
      + vpc_id = (known after apply)
    }

  # aws_iam_role.app will be created
  + resource "aws_iam_role" "app" {
      + arn = (known after apply)
      + assume_role_policy = jsonencode(
          + {
              + Statement = [
                  + {
                      + Action = "sts:AssumeRole"
                      + Effect = "Allow"
                      + Principal = {
                          + Service = "ec2.amazonaws.com"
                        }
                    },
                ]
              + Version = "2012-10-17"
            }
        )
      + create_date = (known after apply)
      + id = (known after apply)
      + name = "app-role"
      + unique_id = (known after apply)
    }

  # aws_iam_role_policy.app will be created
  + resource "aws_iam_role_policy" "app" {
      + id = (known after apply)
      + name = "app-policy"
      + policy = jsonencode(
          + {
              + Statement = [
                  + {
                      + Action = [
                          + "s3:GetObject",
                          + "s3:PutObject",
                        ]
                      + Effect = "Allow"
                      + Resource = "arn:aws:s3:::my-app-bucket-12345/data/*"
                    },
                ]
              + Version = "2012-10-17"
            }
        )
      + role = (known after apply)
    }

Plan: 6 to add, 0 to change, 0 to destroy.
