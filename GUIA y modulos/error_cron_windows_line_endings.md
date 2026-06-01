# Solución a error de scripts `.sh` (cron.sh) por finales de línea de Windows

## Problema
Al intentar ejecutar un script de shell (por ejemplo, `cron.sh`) en un servidor Linux (como Hostinger) a través de SSH o tareas Cron, puedes encontrarte con el siguiente error:
```bash
line 1: cd: $'/ruta/al/directorio\r': No such file or directory
```

## Causa
Este error ocurre porque el archivo `.sh` fue creado o editado en un entorno Windows. Windows utiliza una combinación de retorno de carro y salto de línea (`\r\n`) para indicar el final de una línea, mientras que Linux espera únicamente un salto de línea (`\n`). 
Cuando Linux lee el archivo, interpreta el retorno de carro (`\r`) como parte del nombre del directorio u orden, lo que provoca el fallo porque ese directorio "invisible" no existe.

## Solución
Para solucionar el problema, debes limpiar los finales de línea del archivo en el servidor Linux usando el comando `sed`.

Ejecuta el siguiente comando por SSH apuntando a la ruta de tu script:

```bash
sed -i 's/\r$//' /ruta/absoluta/al/script.sh
```

**Ejemplo aplicado al scraper:**
```bash
sed -i 's/\r$//' /home/u692901087/domains/bot.cdelu.io/nodejs/cron.sh
```

### Ejecución luego del arreglo
Una vez corregido el archivo, puedes ejecutar el script con normalidad:
```bash
/bin/sh /home/u692901087/domains/bot.cdelu.io/nodejs/cron.sh
```
