resource "aws_rds_cluster" "prod" {
  cluster_identifier = "prod-database"
  engine             = "aurora-mysql"
  engine_version     = "8.0.mysql_aurora.3.02.0"
  database_name      = "proddb"
  master_username    = "admin"
  master_password    = var.db_password

  backup_retention_period      = 30
  preferred_backup_window      = "03:00-04:00"
  preferred_maintenance_window = "sun:04:00-sun:05:00"

  storage_encrypted = true
  kms_key_id        = aws_kms_key.rds.arn

  # WARNING: Changing this will force cluster replacement (destructive)
  db_subnet_group_name = aws_db_subnet_group.prod.name

  tags = {
    Name        = "prod-database"
    Environment = "production"
  }
}

resource "aws_db_subnet_group" "prod" {
  name       = "prod-db-subnet"
  subnet_ids = var.private_subnet_ids

  tags = {
    Name = "prod-db-subnet"
  }
}

resource "aws_kms_key" "rds" {
  description             = "KMS key for RDS encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = {
    Name = "rds-key"
  }
}

resource "aws_kms_alias" "rds" {
  name          = "alias/rds-key"
  target_key_id = aws_kms_key.rds.key_id
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "private_subnet_ids" {
  type = list(string)
}
