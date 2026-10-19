// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <functional>
#include <QStringList>

class QWidget;

namespace Web::Qt {

void OpenGameFile(QWidget* parent, const QStringList& extensions,
                  std::function<void(const QString&)> completed);

} // namespace Web::Qt
