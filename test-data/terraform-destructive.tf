Terraform will perform the following actions:

  # aws_rds_cluster.prod must be replaced
  -/+ resource "aws_rds_cluster" "prod" {
        ~ db_subnet_group_name = "old-prod-db-subnet" -> "prod-db-subnet" # forces replacement
        + backup_retention_period = 30
        + cluster_identifier = "prod-database"
        + database_name = "proddb"
        + enable_http_endpoint = false
        + engine = "aurora-mysql"
        + engine_version = "8.0.mysql_aurora.3.02.0"
        + hosted_zone_id = (known after apply)
        + iam_database_authentication_enabled = false
        + iam_roles = (known after apply)
        + id = (known after apply)
        + master_password = (sensitive value)
        + master_username = "admin"
        + preferred_backup_window = "03:00-04:00"
        + preferred_maintenance_window = "sun:04:00-sun:05:00"
        + storage_encrypted = true
        + tags = {
            + "Environment" = "production"
            + "Name" = "prod-database"
          }
    }

  # aws_db_subnet_group.prod will be created
  + resource "aws_db_subnet_group" "prod" {
      + arn = (known after apply)
      + description = (known after apply)
      + id = (known after apply)
      + name = "prod-db-subnet"
      + subnet_ids = [
          + "subnet-12345678",
          + "subnet-87654321",
        ]
      + tags = {
          + "Name" = "prod-db-subnet"
        }
    }

  # aws_kms_key.rds will be created
  + resource "aws_kms_key" "rds" {
      + arn = (known after apply)
      + creation_date = (known after apply)
      + description = "KMS key for RDS encryption"
      + enable_key_rotation = true
      + id = (known after apply)
      + key_id = (known after apply)
      + tags = {
          + "Name" = "rds-key"
        }
    }

Plan: 3 to add, 0 to change, 1 to destroy.

Note: You didn't use the -out option to save this plan, so Terraform can't guarantee to perform exactly these actions if you run "terraform apply" now.
