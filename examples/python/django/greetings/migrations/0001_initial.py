from django.db import migrations, models


def seed_ada(apps, schema_editor) -> None:
    Greeting = apps.get_model("greetings", "Greeting")
    Greeting.objects.using(schema_editor.connection.alias).update_or_create(
        name="Ada",
        defaults={"message": "Hello, Ada!"},
    )


def remove_ada(apps, schema_editor) -> None:
    Greeting = apps.get_model("greetings", "Greeting")
    Greeting.objects.using(schema_editor.connection.alias).filter(name="Ada").delete()


class Migration(migrations.Migration):
    initial = True
    dependencies = []  # noqa: RUF012 - Django migration declaration
    operations = [  # noqa: RUF012 - Django migration declaration
        migrations.CreateModel(
            name="Greeting",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("name", models.CharField(max_length=100, unique=True)),
                ("message", models.CharField(max_length=255)),
            ],
        ),
        migrations.RunPython(seed_ada, remove_ada),
    ]
